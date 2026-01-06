import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import XLSX from "xlsx";

const app = express();
app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// public лежит на уровень выше app
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// --- DB (SQLite) ---
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manager TEXT NOT NULL,
      restaurant TEXT NOT NULL,
      reason TEXT NOT NULL,
      amount INTEGER NOT NULL,
      start TEXT,
      end TEXT,
      comment TEXT,
      created_at INTEGER NOT NULL
    )
  `);
});

// helpers
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// list
app.get("/api/reports", async (req, res) => {
  try {
    const rows = await all(`SELECT * FROM reports ORDER BY created_at DESC`);
    res.json({ ok: true, reports: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// create
app.post("/api/reports", async (req, res) => {
  try {
    const { manager, restaurant, reason, amount, start, end, comment } = req.body || {};

    if (!manager || !restaurant || !reason) {
      return res.status(400).json({ ok: false, error: "Заполни менеджера, ресторан и причину." });
    }
    const nAmount = Number(amount);
    if (!Number.isFinite(nAmount) || nAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Укажи сумму больше нуля." });
    }

    const created_at = Date.now();

    const r = await run(
      `INSERT INTO reports (manager, restaurant, reason, amount, start, end, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(manager).trim(),
        String(restaurant).trim(),
        String(reason).trim(),
        Math.round(nAmount),
        start ? String(start) : "",
        end ? String(end) : "",
        comment ? String(comment) : "",
        created_at
      ]
    );

    const row = await get(`SELECT * FROM reports WHERE id = ?`, [r.lastID]);

    // Отправка в Telegram (опционально)
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const TG_CHAT_ID = process.env.TG_CHAT_ID;
    if (BOT_TOKEN && TG_CHAT_ID) {
      const text =
        `🚨 ОТЧЕТ ПО ПОТЕРЯМ\n\n` +
        `👤 Менеджер: ${row.manager}\n` +
        `🏢 Ресторан: ${row.restaurant}\n` +
        `⚠️ Причина: ${row.reason}\n` +
        `💰 Сумма: ${Number(row.amount).toLocaleString()} ₸\n\n` +
        `🕒 Начало: ${row.start || "-"}\n` +
        `🕒 Конец: ${row.end || "-"}\n\n` +
        `💬 Детали: ${row.comment || "-"}`;

      try {
        const tgResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: TG_CHAT_ID, text })
        });
        await tgResp.json().catch(() => ({}));
      } catch (_) {
        // не валим создание отчета из-за телеги
      }
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

    const existing = await get(`SELECT * FROM reports WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ ok: false, error: "Not found." });

    const { manager, restaurant, reason, amount, start, end, comment } = req.body || {};

    const nAmount = Number(amount);
    if (!manager || !restaurant || !reason) {
      return res.status(400).json({ ok: false, error: "Заполни менеджера, ресторан и причину." });
    }
    if (!Number.isFinite(nAmount) || nAmount <= 0) {
      return res.status(400).json({ ok: false, error: "Укажи сумму больше нуля." });
    }

    await run(
      `UPDATE reports
       SET manager=?, restaurant=?, reason=?, amount=?, start=?, end=?, comment=?
       WHERE id=?`,
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

    const row = await get(`SELECT * FROM reports WHERE id = ?`, [id]);
    res.json({ ok: true, report: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// delete
app.delete("/api/reports/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Bad id." });

    await run(`DELETE FROM reports WHERE id=?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// export excel (server-side) — работает и на iPhone в Telegram
app.get("/api/export.xlsx", async (req, res) => {
  try {
    const rows = await all(`SELECT * FROM reports ORDER BY created_at DESC`);

    const data = rows.map((r) => ({
      "ID": r.id,
      "ТУ": r.manager,
      "Ресторан": r.restaurant,
      "Причина": r.reason,
      "Сумма потерь (₸)": Number(r.amount),
      "Начало": r.start || "",
      "Конец": r.end || "",
      "Комментарий": r.comment || "",
      "Создано (ts)": r.created_at
    }));

    const ws = XLSX.utils.json_to_sheet(data);

    // формат суммы в ₸
    const range = XLSX.utils.decode_range(ws["!ref"]);
    // колонка "Сумма потерь (₸)" — индекс 4 (0-based)
    for (let R = range.s.r + 1; R <= range.e.r; R++) {
      const cell = XLSX.utils.encode_cell({ c: 4, r: R });
      if (ws[cell]) {
        ws[cell].t = "n";
        ws[cell].z = '#,##0 "₸"';
      }
    }

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
app.listen(PORT, () => console.log(`Running on ${PORT}, DB=${DB_PATH}`));
