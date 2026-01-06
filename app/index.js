import express from "express";
import path from "path";

const app = express();
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));

const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.listen(process.env.PORT || 3000);
