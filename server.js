const express = require("express");
const fetch = require("node-fetch");
const app = express();

app.use(express.json());

const TRADINGVIEW_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbzeoar5TzEkJPJz603zGLN91qS1W3A8W2KP1F9fV7C7v5MIHySefWvdUJn2NOMfVVFafg/exec"; // replace with your TradingView alert URL

// Receive tickers from Google Sheets
app.post("/sendTickers", async (req, res) => {
  const tickers = req.body.tickers;
  if (!tickers || !Array.isArray(tickers)) {
    return res.status(400).json({ error: "Tickers array required" });
  }

  for (const ticker of tickers) {
    const payload = {
      ticker: ticker,
      timestamp: new Date().toISOString()
    };

    try {
      await fetch(TRADINGVIEW_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      console.log(`Sent ${ticker} to TradingView`);
    } catch (err) {
      console.error(`Error sending ${ticker}:`, err);
    }
  }

  res.json({ status: "ok", sent: tickers.length });
});

// Health check
app.get("/", (req, res) => res.send("Server is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
