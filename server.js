const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("Server is running");
});

// Sheets → Node
app.post("/send", async (req, res) => {
  try {
    const url = process.env.TRADINGVIEW_WEBHOOK_URL;
    if (!url) return res.status(500).json({ error: "TRADINGVIEW_WEBHOOK_URL not set" });

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    res.json({ ok: r.ok, status: r.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// TradingView → Node (later)
app.post("/tradingview", (req, res) => {
  console.log("TradingView Alert:", req.body);
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
