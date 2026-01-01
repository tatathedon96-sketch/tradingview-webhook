const express = require("express");
const axios = require("axios");

const app = express();          // ✅ CREATE app FIRST
app.use(express.json());        // ✅ THEN use middleware

const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const TRADINGVIEW_WEBHOOK_URL = process.env.TRADINGVIEW_WEBHOOK_URL;

// ===== HEALTH CHECK =====
app.get("/", (req, res) => {
  res.send("Server is running");
});

// ===== RECEIVE FROM GOOGLE SHEETS =====
app.post("/send", async (req, res) => {
  const { tickers } = req.body;

  if (!Array.isArray(tickers)) {
    return res.status(400).json({ error: "tickers must be an array" });
  }

  const results = [];

  for (const ticker of tickers) {
    try {
      await axios.post(TRADINGVIEW_WEBHOOK_URL, { ticker });
      results.push({ ticker, status: "SENT" });
    } catch (err) {
      results.push({ ticker, status: "FAILED" });
    }
  }

  res.json({ results });
});

// ===== RECEIVE FROM TRADINGVIEW =====
app.post("/tradingview", (req, res) => {
  console.log("TradingView Alert:", req.body);
  res.send("OK");
});

// ===== START SERVER =====
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
