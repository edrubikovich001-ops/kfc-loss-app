import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import crypto from "crypto";
import pg from "pg";
import dns from "dns";

dns.setDefaultResultOrder("ipv4first"); // ✅ КЛЮЧЕВО: заставляем Node выбирать IPv4

const { Pool } = pg;

const app = express();
app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// public лежит на уровень выше app
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

const DATABASE_URL_RAW = process.env.DATABASE_URL;

if (!DATABASE_URL_RAW) {
  console.error("FATAL: DATABASE_URL is missing. Set it in Render Environment.");
}

// ✅ страховка: если хост — ipv6 без [] (иногда так приходит), оборачиваем
function normalizeDbUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    // если хост содержит ":" и не в квадратных — это IPv6
    if (u.hostname.includes(":") && !u.host.startsWith("[")) {
      u.host = `[${u.hostname}]${u.port ? ":" + u.port : ""}`;
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

const DATABASE_URL = normalizeDbUrl(DATABASE_URL_RAW);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

async function q(text, params) {
  const r = await pool.query(text, params);
  return r;
}

function parseRuDT(s) {
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

let dbReady = false;
let dbLastError = null;

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
    await q("SELECT 1 as ok");
    await ensureSchema();
    dbReady = true;
    dbLastError = null;
    console.log("DB: connected and schema ensured ✅");
  } catch (e) {
    dbReady = false;
    dbLastError = e?.message || String(e);
    console.error("DB init failed:", dbLastError);
  }
}

// ✅ НЕ валим старт сервера, даже если база недоступна
await initDb();

// health
app.get("/api/health", async (req, res) => {
  try {
    await q("SELECT 1 as ok");
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e?.message || "db error" });
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

// create (защита от дубля по request_id)
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

// export excel — нужные колонки + формат ₸
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

    if (ws["!ref"]) {
      const range = XLSX.utils.decode_range(ws["!ref"]);
      // сумма — колонка 7
      for (let R = range.s.r + 1; R <= range.e.r; R++) {
        const cell = XLSX.utils.encode_cell({ c: 7, r: R });
        if (ws[cell]) {
          ws[cell].t = "n";
          ws[cell].z = '#,##0 "₸"';
        }
      }
    }

    ws["!cols"] = [
      { wch: 22 },
      { wch: 28 },
      { wch: 22 },
      { wch: 40 },
      { wch: 20 },
      { wch: 20 },
      { wch: 14 },
      { wch: 18 }
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

// отдаём index.html на все не-api пути
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
