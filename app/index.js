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
 * ENV (Render -> Environment Variables):
 * DATABASE_URL  - Supabase Session Pooler URL (IPv4 compatible)
 * BOT_TOKEN     - Telegram bot token (optional)
 * TG_CHAT_ID    - chat_id (optional)
 */
const DATABASE_URL = process.env.DATABASE_URL;

let dbReady = false;
let dbError = null;

function safeStr(v) {
  return (v ?? "").toString();
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
  return Math.round(diff * 100) / 100;
}

let pool = null;

function buildPool() {
  if (!DATABASE_URL) {
    dbReady = false;
    dbError = "DATABASE_URL is missing";
    return null;
  }

  // ВАЖНО:
  // Supabase pooler часто отдаёт цепочку сертификатов, которую Node считает "self-signed".
  // Решение: ssl.rejectUnauthorized=false (это нормальная практика для Supabase pooler на хостингах).
  // НИКАКОГО NODE_TLS_REJECT_UNAUTHORIZED=0 не нужно.
  return new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000
  });
}

async function q(text, params) {
  if (!pool) throw new Error("DB pool not initialized");
  return pool.query(text, params);
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

async function initDb() {
  try {
    pool = buildPool();
    if (!pool) throw new Error(dbError || "No pool");
    await q("SELECT 1 as ok");
    await ensureSchema();
    dbReady = true;
    dbError = null;
  } catch (e) {
    dbReady = false;
    dbError = e?.message || String(e);
    console.error("DB init failed:", dbError);
  }
}

// стартуем без падения сайта
await initDb();

// health
app.get("/api/health", async (req, res) => {
  try {
    if (!pool) return res.status(200).json({ ok: false, dbReady, error: dbError || "No DATABASE_URL" });
    await q("SELECT 1 as ok");
    res.json({ ok: true, dbReady: true });
  } catch (e) {
    res.status(200).json({ ok: false, dbReady: false, error: e?.message || "db error" });
  }
});

// list
app.get("/api/reports", async (req, res) => {
  try {
    if (!dbReady) return res.status(500).json({ ok: false, error: dbError || "DB not ready" });
    const r = await q(`SELECT * FROM reports ORDER BY created_at DESC`);
    res.json({ ok: true, reports: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// create (анти-дубль по request_id)
app.post("/api/reports", async (req, res) => {
  try {
    if (!dbReady) return res.status(500).json({ ok: false, error: dbError || "DB not ready" });

    const { manager, restaurant, reason, amount, start, end, comment, request_id } = req.body || {};

    if (!manager || !restaurant || !reason) {
      return res.status(400).json({ ok: false, error: "Заполни менеджера, ресторан и причину." });
    }
    const nAmount = Number(amount);
    if (!Number.isFinite(nAmount) || nAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Укажи сумму больше нуля." });
    }

    const created_at = Date.now();
    const rid = (request_id && safeStr(request_id).trim()) || crypto.randomUUID();

    await q(
      `
      INSERT INTO reports (request_id, manager, restaurant, reason, comment, start, "end", amount, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (request_id) DO NOTHING
      `,
      [
        rid,
        safeStr(manager).trim(),
        safeStr(restaurant).trim(),
        safeStr(reason).trim(),
        comment ? safeStr(comment) : "",
        start ? safeStr(start) : "",
        end ? safeStr(end) : "",
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
    if (!dbReady) return res.status(500).json({ ok: false, error: dbError || "DB not ready" });

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
        safeStr(manager).trim(),
        safeStr(restaurant).trim(),
        safeStr(reason).trim(),
        Math.round(nAmount),
        start ? safeStr(start) : "",
        end ? safeStr(end) : "",
        comment ? safeStr(comment) : "",
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
    if (!dbReady) return res.status(500).json({ ok: false, error: dbError || "DB not ready" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Bad id." });

    await q(`DELETE FROM reports WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// export excel (серверный) — нужные колонки + формат ₸
app.get("/api/export.xlsx", async (req, res) => {
  try {
    if (!dbReady) return res.status(500).json({ ok: false, error: dbError || "DB not ready" });

    const rows = (await q(`SELECT * FROM reports ORDER BY created_at DESC`)).rows;

    const data = rows.map((r) => ({
      "ТУ": r.manager,
      "Ресторан": r.restaurant,
      "Причина": r.reason,
      "Комментарий": r.comment || "",
      "Начало инцидента": r.start || "",
      "Конец инцидента": r.end || "",
      "Длительность в часах": hoursDiff(r.start, r.end),
      "Сумма потерь": Number(r.amount) || 0
    }));

    const ws = XLSX.utils.json_to_sheet(data);

    // Формат суммы: колонка "Сумма потерь" = последняя (индекс 7)
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

    // ширины колонок
    ws["!cols"] = [
      { wch: 22 }, // ТУ
      { wch: 34 }, // Ресторан
      { wch: 22 }, // Причина
      { wch: 46 }, // Комментарий
      { wch: 20 }, // Начало
      { wch: 20 }, // Конец
      { wch: 18 }, // Длительность
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

// если база поднялась позже — можно дернуть /api/health, и сделать реинициализацию
app.post("/api/reinit-db", async (req, res) => {
  await initDb();
  res.json({ ok: dbReady, dbReady, error: dbError });
});

// Telegram WebApp может приходить с любыми путями — отдаём index.html
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
