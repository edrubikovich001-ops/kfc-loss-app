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
const BOT_TOKEN = process.env.BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is missing. Set it in Render Environment.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

// --- helpers ---
async function q(text, params) {
  return pool.query(text, params);
}

function parseRuDT(s) {
  // "07.01.2026 10:00"
  if (!s || typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const dd = Number(m[1]),
    mm = Number(m[2]) - 1,
    yy = Number(m[3]),
    hh = Number(m[4]),
    mi = Number(m[5]);
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

function normalizeStr(x) {
  return String(x ?? "").trim().replace(/\s+/g, " ");
}

/**
 * ВАЖНО:
 * Если фронт НЕ прислал request_id, делаем стабильный request_id сами:
 * хеш по ключевым полям. Тогда повторная отправка того же payload не создаст дубль.
 */
function makeRequestIdFromPayload({ manager, restaurant, reason, amount, start, end, comment }) {
  const base = [
    normalizeStr(manager),
    normalizeStr(restaurant),
    normalizeStr(reason),
    String(Number(amount) || 0),
    normalizeStr(start),
    normalizeStr(end),
    normalizeStr(comment),
  ].join("|");

  return crypto.createHash("sha256").update(base).digest("hex").slice(0, 32);
}

async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
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

// create (антидубль)
app.post("/api/reports", async (req, res) => {
  try {
    const body = req.body || {};
    const manager = normalizeStr(body.manager);
    const restaurant = normalizeStr(body.restaurant);
    const reason = normalizeStr(body.reason);
    const comment = normalizeStr(body.comment || "");
    const start = normalizeStr(body.start || "");
    const end = normalizeStr(body.end || "");
    const nAmount = Number(body.amount);

    if (!manager || !restaurant || !reason) {
      return res.status(400).json({ ok: false, error: "Заполни менеджера, ресторан и причину." });
    }
    if (!Number.isFinite(nAmount) || nAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Укажи сумму больше нуля." });
    }

    // request_id:
    // - если фронт прислал: используем его
    // - иначе: делаем стабильный хеш из payload (это и убирает дубли)
    const rid = normalizeStr(body.request_id) || makeRequestIdFromPayload({
      manager,
      restaurant,
      reason,
      amount: nAmount,
      start,
      end,
      comment,
    });

    const created_at = Date.now();

    await q(
      `
      INSERT INTO reports (request_id, manager, restaurant, reason, comment, start, "end", amount, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (request_id) DO NOTHING
      `,
      [rid, manager, restaurant, reason, comment, start, end, Math.round(nAmount), created_at]
    );

    const row = (await q(`SELECT * FROM reports WHERE request_id=$1`, [rid])).rows[0];

    // Telegram (опционально) — слать только если запись реально есть
    // (а она будет либо новая, либо уже существующая — но дублей не будет)
    if (BOT_TOKEN && TG_CHAT_ID && row) {
      const text =
        `🚨 ОТЧЕТ ПО ПОТЕРЯМ\n\n` +
        `👤 Менеджер: ${row.manager}\n` +
        `🏢 Ресторан: ${row.restaurant}\n` +
        `⚠️ Причина: ${row.reason}\n` +
        `💰 Сумма: ${Number(row.amount).toLocaleString()} ₸\n\n` +
        `🕒 Начало: ${row.start || "-"}\n` +
        `🕒 Конец: ${row.end || "-"}\n` +
        `⏱ Длительность: ${hoursDiff(row.start, row.end) || "-"} ч\n\n` +
        `💬 Комментарий: ${row.comment || "-"}`;

      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
        }).then((r) => r.json()).catch(() => ({}));
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

    const body = req.body || {};
    const manager = normalizeStr(body.manager);
    const restaurant = normalizeStr(body.restaurant);
    const reason = normalizeStr(body.reason);
    const comment = normalizeStr(body.comment || "");
    const start = normalizeStr(body.start || "");
    const end = normalizeStr(body.end || "");
    const nAmount = Number(body.amount);

    if (!manager || !restaurant || !reason) {
      return res.status(400).json({ ok: false, error: "Заполни менеджера, ресторан и причину." });
    }
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
      [manager, restaurant, reason, Math.round(nAmount), start, end, comment, id]
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

// export excel (серверный) — строго в нужном порядке колонок
app.get("/api/export.xlsx", async (req, res) => {
  try {
    const rows = (await q(`SELECT * FROM reports ORDER BY created_at DESC`)).rows;

    // ВАЖНО: порядок колонок как ты просил
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

    // ширины колонок (аккуратно)
    ws["!cols"] = [
      { wch: 22 }, // ТУ
      { wch: 30 }, // Ресторан
      { wch: 22 }, // Причина
      { wch: 45 }, // Комментарий
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

// Telegram WebApp может приходить с любыми путями — отдаём index.html
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
