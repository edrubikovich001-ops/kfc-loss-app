import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// public лежит на уровень выше app
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

/**
 * ENV
 * DATABASE_URL  - строка подключения Supabase Postgres (лучше pooled)
 * BOT_TOKEN     - телеграм бот токен (опционально)
 * TG_CHAT_ID    - chat_id куда слать (опционально)
 */
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is missing. Set it in Render Environment.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false }
});

// --- helpers ---
async function q(text, params) {
  const r = await pool.query(text, params);
  return r;
}

function parseRuDT(s) {
  // "07.01.2026 10:00"
  if (!s || typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]) - 1, yy = Number(m[3]), hh = Number(m[4]), mi = Number(m[5]);
  const d = new Date(yy, mm, dd, hh, mi);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function hoursDiff(startStr, endStr) {
  const a = parseRuDT(startStr);
  const b = parseRuDT(endStr);
  if (!a || !b) return "";
  const diff = (b.getTime() - a.getTime()) / (1000 * 60 * 60);
  return Math.round(diff * 100) / 100; // 2 знака
}

async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      request_id TEXT UNIQUE,
      manager TEXT NOT NULL,
      restaurant TEXT NOT NULL,
      reason TEXT NOT NULL,
      comment TEXT,
      start TEXT,
      "end" TEXT,
      amount INTEGER NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
}

await ensureSchema();

// health
app.get("/api/health", async (req, res) => {
  try {
    await q("SELECT 1 as ok");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "db error" });
  }
});

// list
app.get("/api/reports", async (req, res) => {
  try {
    const r = await q(`SELECT * FROM reports ORDER BY created_at DESC`);
    res.json({ ok: true, reports: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// create (с защитой от дубля по request_id)
app.post("/api/reports", async (req, res) => {
  try {
    const { manager, restaurant, reason, amount, start, end, comment, request_id } = req.body || {};

    if (!manager || !restaurant || !reason) {
      return res.status(400).json({ ok: false, error: "Заполни менеджера, ресторан и причину." });
    }
    const nAmount = Number(amount);
    if (!Number.isFinite(nAmount) || nAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Укажи сумму больше нуля." });
    }

    const created_at = Date.now();
    const rid = (request_id && String(request_id).trim()) || crypto.randomUUID();

    // INSERT ... ON CONFLICT DO NOTHING → если дубль, просто вернём существующую запись
    await q(
      `
      INSERT INTO reports (request_id, manager, restaurant, reason, comment, start, "end", amount, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (request_id) DO NOTHING
      `,
      [
        rid,
        String(manager).trim(),
        String(restaurant).trim(),
        String(reason).trim(),
        comment ? String(comment) : "",
        start ? String(start) : "",
        end ? String(end) : "",
        Math.round(nAmount),
        created_at
      ]
    );

    const row = (await q(`SELECT * FROM reports WHERE request_id=$1`, [rid])).rows[0];

    // Telegram (опционально)
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const TG_CHAT_ID = process.env.TG_CHAT_ID;
    if (BOT_TOKEN && TG_CHAT_ID && row) {
      const text =
        `🚨 ОТЧЕТ ПО ПОТЕРЯМ\n\n` +
        `👤 Менеджер: ${row.manager}\n` +
        `🏢 Ресторан: ${row.restaurant}\n` +
        `⚠️ Причина: ${row.reason}\n` +
        `💰 Сумма: ${Number(row.amount).toLocaleString()} ₸\n\n` +
        `🕒 Начало: ${row.start || "-"}\n` +
        `🕒 Конец: ${row.end || "-"}\n\n` +
        `💬 Комментарий: ${row.comment || "-"}`;

      try {
        const tgResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: TG_CHAT_ID, text })
        });
        await tgResp.json().catch(() => ({}));
      } catch (_) {}
    }

    res.json({ ok: true, report: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// update
app.put("/api/reports/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Bad id." });

    const existing = (await q(`SELECT * FROM reports WHERE id=$1`, [id])).rows[0];
    if (!existing) return res.status(404).json({ ok: false, error: "Not found." });

    const { manager, restaurant, reason, amount, start, end, comment } = req.body || {};

    if (!manager || !restaurant || !reason) {
      return res.status(400).json({ ok: false, error: "Заполни менеджера, ресторан и причину." });
    }
    const nAmount = Number(amount);
    if (!Number.isFinite(nAmount) || nAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Укажи сумму больше нуля." });
    }

    const r = await q(
      `
      UPDATE reports
      SET manager=$1, restaurant=$2, reason=$3, amount=$4, start=$5, "end"=$6, comment=$7
      WHERE id=$8
      RETURNING *
      `,
      [
        String(manager).trim(),
        String(restaurant).trim(),
        String(reason).trim(),
        Math.round(nAmount),
        start ? String(start) : "",
        end ? String(end) : "",
        comment ? String(comment) : "",
        id
      ]
    );

    res.json({ ok: true, report: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// delete
app.delete("/api/reports/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Bad id." });

    await q(`DELETE FROM reports WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// export excel (серверный) — с нужными колонками
app.get("/api/export.xlsx", async (req, res) => {
  try {
    const rows = (await q(`SELECT * FROM reports ORDER BY created_at DESC`)).rows;

    const data = rows.map((r) => ({
      "ТУ": r.manager,
      "Ресторан": r.restaurant,
      "Причина": r.reason,
      "Комментарий": r.comment || "",
      "Начало инцидента": r.start || "",
      "Конец инцидента": r.end || "",
      "Длительность (ч)": hoursDiff(r.start, r.end),
      "Сумма потерь (₸)": Number(r.amount) || 0
    }));

    const ws = XLSX.utils.json_to_sheet(data);

    // Формат суммы в ₸: последняя колонка (индекс 7)
    if (ws["!ref"]) {
      const range = XLSX.utils.decode_range(ws["!ref"]);
      for (let R = range.s.r + 1; R <= range.e.r; R++) {
        const cell = XLSX.utils.encode_cell({ c: 7, r: R });
        if (ws[cell]) {
          ws[cell].t = "n";
          ws[cell].z = '#,##0 "₸"';
        }
      }
    }

    // Чуть “красоты”: ширины колонок
    ws["!cols"] = [
      { wch: 22 }, // ТУ
      { wch: 28 }, // Ресторан
      { wch: 22 }, // Причина
      { wch: 40 }, // Комментарий
      { wch: 20 }, // Начало
      { wch: 20 }, // Конец
      { wch: 14 }, // Длительность
      { wch: 18 }  // Сумма
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Loss");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const filename = `KFC_Loss_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// Telegram WebApp может приходить с любыми путями — отдаём index.html
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
