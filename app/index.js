import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import ExcelJS from "exceljs";
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
 * DATABASE_URL
 * BOT_TOKEN
 * TG_CHAT_ID
 * TG_THREAD_ID   <-- ВАЖНО
 * MIGRATE_KEY
 */
const DATABASE_URL = process.env.DATABASE_URL;

// --- helpers ---
function safeErr(e) {
  return {
    message: e?.message || String(e),
    code: e?.code || null,
    detail: e?.detail || null,
    hint: e?.hint || null,
    where: e?.where || null,
    stack: e?.stack ? String(e.stack).slice(0, 1200) : null
  };
}

function withSslModeRequire(url) {
  if (!url) return url;
  if (url.includes("sslmode=")) return url;
  return url.includes("?") ? `${url}&sslmode=require` : `${url}?sslmode=require`;
}

const pool = new Pool({
  connectionString: withSslModeRequire(DATABASE_URL),
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 30000,
  max: 5
});

async function q(text, params) {
  return await pool.query(text, params);
}

// ---------------- DB INIT ----------------
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

let dbReady = false;
let dbError = "";
let dbErrorFull = null;

async function initDb() {
  try {
    if (!DATABASE_URL) {
      dbReady = false;
      dbError = "DATABASE_URL is missing";
      return;
    }
    await q("SELECT 1");
    await ensureSchema();
    dbReady = true;
    dbError = "";
  } catch (e) {
    dbReady = false;
    const info = safeErr(e);
    dbError = info.message;
    dbErrorFull = info;
    console.error("DB init failed:", info);
  }
}

await initDb();

// ---------------- CREATE REPORT ----------------
app.post("/api/reports", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: dbError });

    const { manager, restaurant, reason, amount, start, end, comment, request_id } = req.body || {};
    if (!manager || !restaurant || !reason) {
      return res.status(400).json({ ok: false, error: "Заполни менеджера, ресторан и причину." });
    }

    const nAmount = Number(amount);
    if (!Number.isFinite(nAmount) || nAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Укажи сумму больше нуля." });
    }

    const created_at = Date.now();
    const rid = request_id || crypto.randomUUID();

    await q(
      `
      INSERT INTO reports (request_id, manager, restaurant, reason, comment, start, "end", amount, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (request_id) DO NOTHING
      `,
      [
        rid,
        manager,
        restaurant,
        reason,
        comment || "",
        start || "",
        end || "",
        Math.round(nAmount),
        created_at
      ]
    );

    const row = (await q(`SELECT * FROM reports WHERE request_id=$1`, [rid])).rows[0];

    // ---------------- TELEGRAM ----------------
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const TG_CHAT_ID = process.env.TG_CHAT_ID;
    const TG_THREAD_ID = process.env.TG_THREAD_ID;

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
        const payload = {
          chat_id: TG_CHAT_ID,
          text
        };

        // 🔥 ВАЖНО: отправка В КОНКРЕТНУЮ ТЕМУ
        if (TG_THREAD_ID && String(TG_THREAD_ID).trim()) {
          payload.message_thread_id = Number(TG_THREAD_ID);
        }

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } catch (e) {
        console.error("Telegram error:", e);
      }
    }

    res.json({ ok: true, report: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// ---------------- SERVER ----------------
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
