import express from "express";
import path from "path";

const app = express();
app.use(express.json({ limit: "200kb" }));

// Проверка, что сервер жив
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Отправка сообщения в Telegram
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.post("/api/send", async (req, res) => {
  try {
    if (!BOT_TOKEN || !CHAT_ID) {
      return res.status(500).json({ ok: false, error: "BOT_TOKEN/CHAT_ID not set" });
    }

    const { manager, restaurant, reason, amount, start, end, comment } = req.body || {};
    const nAmount = Number(amount);

    const message =
`🚨 ОТЧЕТ ПО ПОТЕРЯМ

👤 Менеджер: ${manager || "-"}
🏢 Ресторан: ${restaurant || "-"}
⚠️ Причина: ${reason || "-"}
💰 Сумма: ${Number.isFinite(nAmount) ? nAmount.toLocaleString() : "-"} ₸

🕒 Начало: ${start || "-"}
🕒 Конец: ${end || "-"}

💬 Детали: ${(comment || "-").toString().slice(0, 2000)}`;

    const tgResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message })
    });

    const tgText = await tgResp.text();
    if (!tgResp.ok) return res.status(502).json({ ok: false, error: tgText });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
});

// Раздаём фронт из /public
const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.listen(process.env.PORT || 3000);
