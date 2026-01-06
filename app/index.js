import express from "express";
import path from "path";

const app = express();
app.use(express.json({ limit: "200kb" }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Логи при старте — чтобы сразу видеть, подхватились ли переменные.
console.log("[BOOT] BOT_TOKEN present:", !!BOT_TOKEN);
console.log("[BOOT] CHAT_ID present:", !!CHAT_ID, "value:", CHAT_ID ? String(CHAT_ID).slice(0, 6) + "..." : "EMPTY");

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/send", async (req, res) => {
  try {
    const { manager, restaurant, reason, amount, start, end, comment } = req.body || {};

    // базовая валидация
    if (!manager || !restaurant || !reason) {
      return res.status(400).json({ ok: false, error: "manager/restaurant/reason required" });
    }
    const nAmount = Number(amount);
    if (!Number.isFinite(nAmount) || nAmount <= 0) {
      return res.status(400).json({ ok: false, error: "amount must be > 0" });
    }

    if (!BOT_TOKEN || !CHAT_ID) {
      console.log("[SEND] Missing env BOT_TOKEN/CHAT_ID");
      return res.status(500).json({ ok: false, error: "Server env BOT_TOKEN/CHAT_ID not set" });
    }

    const text =
      `🚨 ОТЧЕТ ПО ПОТЕРЯМ\n\n` +
      `👤 Менеджер: ${manager}\n` +
      `🏢 Ресторан: ${restaurant}\n` +
      `⚠️ Причина: ${reason}\n` +
      `💰 Сумма: ${Number(nAmount).toLocaleString()} ₸\n\n` +
      `🕒 Начало: ${start || "-"}\n` +
      `🕒 Конец: ${end || "-"}\n\n` +
      `💬 Детали: ${comment || "-"}`;

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    console.log("[SEND] -> Telegram request. chat_id:", CHAT_ID);

    const tgResp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
      }),
    });

    const tgData = await tgResp.json().catch(() => ({}));

    console.log("[SEND] Telegram status:", tgResp.status);
    console.log("[SEND] Telegram response:", JSON.stringify(tgData));

    if (!tgResp.ok || tgData.ok !== true) {
      return res.status(502).json({
        ok: false,
        error: tgData?.description || `Telegram error ${tgResp.status}`,
        tg: tgData,
      });
    }

    return res.json({ ok: true, tg: tgData });
  } catch (e) {
    console.log("[SEND] Exception:", e);
    return res.status(500).json({ ok: false, error: e?.message || "unknown" });
  }
});

// Раздача фронта из папки public на том же уровне, что и app
const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(process.env.PORT || 3000, () => {
  console.log("[BOOT] Listening on port", process.env.PORT || 3000);
});
