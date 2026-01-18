import net from "net";
import dns from "dns/promises";

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

      s.on("connect", () => { s.end(); resolve({ tcp: "OK" }); });
      s.on("timeout", () => { s.destroy(); resolve({ tcp: "TIMEOUT" }); });
      s.on("error", (e) => resolve({ tcp: "ERROR", err: e?.code || e?.message }));
    });

    res.json({ ok: true, host, port, ...out, ...ok });
  } catch (e) {
    res.status(500).json({ ok: false, host, port, error: e?.message || String(e) });
  }
});
