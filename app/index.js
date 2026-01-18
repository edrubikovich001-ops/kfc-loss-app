import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import ExcelJS from "exceljs";
import crypto from "crypto";
import pg from "pg";
import net from "net";
import dns from "dns/promises";

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
 * DATABASE_URL  - строка подключения Postgres (Render/Supabase)
 * BOT_TOKEN     - телеграм бот токен (опционально)
 * TG_CHAT_ID    - chat_id куда слать (опционально)
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
    stack: e?.stack ? String(e.stack).slice(0, 1400) : null
  };
}

function isSupabaseUrl(url) {
  if (!url) return false;
  return url.includes(".supabase.com");
}

function isRenderPostgresUrl(url) {
  if (!url) return false;
  // типичные признаки Render Postgres
  return url.includes("dpg-") || url.includes("render.com");
}

function withSslModeRequireOnlyForSupabase(url) {
  // sslmode=require оставляем ТОЛЬКО для Supabase.
  if (!url) return url;
  if (!isSupabaseUrl(url)) return url;
  if (url.includes("sslmode=")) return url;
  return url.includes("?") ? `${url}&sslmode=require` : `${url}?sslmode=require`;
}

/**
 * КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ:
 * Render Postgres иногда отдаёт self-signed цепочку,
 * и pg/Node продолжает ругаться даже при ssl.rejectUnauthorized=false.
 * Самый надёжный фикс — отключить проверку TLS на уровне Node (только для Render URL).
 */
if (isRenderPostgresUrl(DATABASE_URL)) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const pool = new Pool({
  connectionString: withSslModeRequireOnlyForSupabase(DATABASE_URL),

  // Для Supabase нужен SSL; для Render тоже может быть SSL,
  // но проверку мы уже отключили через NODE_TLS_REJECT_UNAUTHORIZED=0 (для Render).
  // Здесь ставим ssl=true, чтобы pg не пытался "угадывать".
  ssl: true,

  keepAlive: true,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 30000,
  max: 5
});

async function q(text, params) {
  return await pool.query(text, params);
}

function parseRuDT(s) {
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
  return Math.round(diff * 100) / 100;
}

function splitRestaurant(r) {
  const s = (r || "").trim();
  if (s.includes(" — ")) {
    const parts = s.split(" — ");
    return { code: (parts[0] || "").trim(), name: parts.slice(1).join(" — ").trim() };
  }
  return { code: "", name: s };
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

let dbReady = false;
let dbError = "";
let dbErrorFull = null;

async function initDb() {
  try {
    if (!DATABASE_URL) {
      dbReady = false;
      dbError = "DATABASE_URL is missing";
      dbErrorFull = { message: "DATABASE_URL is missing" };
      return;
    }

    await q("SELECT 1 as ok");
    await ensureSchema();

    dbReady = true;
    dbError = "";
    dbErrorFull = null;
  } catch (e) {
    dbReady = false;
    const info = safeErr(e);
    dbError = info.message || "db init failed";
    dbErrorFull = info;
    console.error("DB init failed:", info);
  }
}

await initDb();

// netcheck (оставляем — полезно)
app.get("/api/netcheck", async (req, res) => {
  const host = "aws-1-ap-south-1.pooler.supabase.com";
  const port = 5432;

  try {
    const out = {};
    const r = await dns.lookup(host);
    out.dns = r;

    const ok = await new Promise((resolve) => {
      const s = net.createConnection({ host, port });
      s.setTimeout(8000);

      s.on("connect", () => {
        s.end();
        resolve({ tcp: "OK" });
      });
      s.on("timeout", () => {
        s.destroy();
        resolve({ tcp: "TIMEOUT" });
      });
      s.on("error", (e) => resolve({ tcp: "ERROR", err: e?.code || e?.message }));
    });

    res.json({ ok: true, host, port, ...out, ...ok });
  } catch (e) {
    res.status(500).json({ ok: false, host, port, error: e?.message || String(e) });
  }
});

// health (расширено)
app.get("/api/health", async (req, res) => {
  try {
    if (!dbReady) {
      return res.json({
        ok: false,
        dbReady: false,
        error: dbError || "db not ready",
        error_full: dbErrorFull,
        hasDatabaseUrl: !!DATABASE_URL
      });
    }
    await q("SELECT 1 as ok");
    res.json({ ok: true, dbReady: true, error: "" });
  } catch (e) {
    const info = safeErr(e);
    res.status(500).json({ ok: false, dbReady: false, error: info.message || "db error", error_full: info });
  }
});

// list
app.get("/api/reports", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: dbError || "db not ready" });
    const r = await q(`SELECT * FROM reports ORDER BY created_at DESC`);
    res.json({ ok: true, reports: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// create (с защитой от дубля по request_id)
app.post("/api/reports", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: dbError || "db not ready" });

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
    if (!dbReady) return res.status(503).json({ ok: false, error: dbError || "db not ready" });

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
    if (!dbReady) return res.status(503).json({ ok: false, error: dbError || "db not ready" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Bad id." });

    await q(`DELETE FROM reports WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// export excel (серверный) — перенос в комментариях + длительность после суммы
app.get("/api/export.xlsx", async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ ok: false, error: dbError || "db not ready" });

    const rows = (await q(`SELECT * FROM reports`)).rows || [];
    rows.sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));

    const wb = new ExcelJS.Workbook();
    wb.creator = "KFC Loss Control";
    wb.created = new Date();

    const ws = wb.addWorksheet("Reports", {
      views: [{ state: "frozen", ySplit: 1 }]
    });

    const header = [
      "ID",
      "Менеджер",
      "Ресторан код",
      "Ресторан",
      "Причина",
      "Сумма",
      "Длительность (ч)",
      "Начало",
      "Конец",
      "Комментарий"
    ];
    ws.addRow(header);

    for (const r of rows) {
      const rr = splitRestaurant(r.restaurant);
      ws.addRow([
        Number(r.id) || "",
        r.manager || "",
        rr.code || "",
        rr.name || "",
        r.reason || "",
        Number(r.amount) || 0,
        hoursDiff(r.start, r.end),
        r.start || "",
        r.end || "",
        r.comment || ""
      ]);
    }

    ws.columns = [
      { width: 10 },
      { width: 22 },
      { width: 14 },
      { width: 28 },
      { width: 18 },
      { width: 14 },
      { width: 16 },
      { width: 18 },
      { width: 18 },
      { width: 34 }
    ];

    ws.autoFilter = { from: "A1", to: "J1" };

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    headerRow.height = 20;

    ws.getColumn(6).numFmt = '#,##0" ₸"';
    ws.getColumn(7).numFmt = "0.00";

    ws.getColumn(10).alignment = { vertical: "top", horizontal: "left", wrapText: true };
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      row.alignment = { vertical: "top", horizontal: "left", wrapText: true };
      row.height = 30;
    }

    const filename = `KFC_Loss_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    res.end();
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
