import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

// === API ===
app.post("/api/send", async (req, res) => {
  try {
    const { manager, restaurant, reason, amount, start, end, comment } = req.body || {};
    if (!manager || !restaurant || !reason) {
      return res.status(400).json({ ok: false, error: "missing fields" });
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID;
    if (!BOT_TOKEN || !CHAT_ID) {
      return res.status(500).json({ ok: false, error: "env not set" });
    }

    const text =
`🚨 ОТЧЕТ ПО ПОТЕРЯМ

👤 Менеджер: ${manager}
🏢 Ресторан: ${restaurant}
⚠️ Причина: ${reason}
💰 Сумма: ${Number(amount).toLocaleString()} ₸

🕒 Начало: ${start}
🕒 Конец: ${end}

💬 Детали: ${comment || "-"}`;

    const tgResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text })
    }).then(r => r.json());

    return res.json({ ok: true, tg: tgResp });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// === WEB APP (public из корня репозитория) ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// public лежит на уровень выше, чем app/
const publicDir = path.join(__dirname, "..", "public");

app.use(express.static(publicDir));

// корень и любые другие роуты — отдаем index.html
app.get("*", (_, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server started");
});
