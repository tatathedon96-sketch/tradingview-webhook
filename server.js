const express = require("express");
const app = express();
app.use(express.json());

/** ========== HEALTH CHECK ========== */
app.get("/", (req, res) => res.status(200).send("Server is running"));

/** ========== MATH HELPERS ========== */
function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }

function variance(a) {
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
}

function covariance(a, b) {
  const ma = mean(a), mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (a.length - 1);
}

function logReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}

function beta(assetR, benchR) {
  const n = Math.min(assetR.length, benchR.length);
  if (n < 10) return null;

  const a = assetR.slice(-n);
  const b = benchR.slice(-n);

  const vb = variance(b);
  if (!isFinite(vb) || vb === 0) return null;

  return covariance(a, b) / vb;
}

function parseBaseSymbol(ticker) {
  const s = String(ticker || "").trim().toUpperCase();
  if (!s) return "";

  // Strip common quote suffixes from TradingView / exchange tickers
  for (const q of ["USDT", "USDC", "USD", "BTC", "ETH"]) {
    if (s.endsWith(q) && s.length > q.length) return s.slice(0, -q.length);
  }

  // If they send "BINANCE:SOLUSDT" style, handle it
  if (s.includes(":")) {
    const after = s.split(":").pop();
    return parseBaseSymbol(after);
  }

  return s;
}

/** ========== CRYPTOCOMPARE DAILY CLOSES (USD) ========== */
// Daily candles only roll once a day, so a few-hours-old close is still valid.
// Cache cuts API usage and lets a run survive transient rate-limit errors.
const CLOSES_TTL_MS = 3 * 60 * 60 * 1000;
const closesCache = new Map(); // "BASE:limitCloses" -> { at, closes }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ccHistodayUSD(base, limitCloses) {
  // CryptoCompare histoday: limit=30 returns 31 candles (today included)
  const url =
    `https://min-api.cryptocompare.com/data/v2/histoday` +
    `?fsym=${encodeURIComponent(base)}` +
    `&tsym=USD` +
    `&limit=${limitCloses - 1}`; // because CC "limit" is number of intervals back

  const headers = {};
  if (process.env.CRYPTOCOMPARE_API_KEY) {
    headers["authorization"] = `Apikey ${process.env.CRYPTOCOMPARE_API_KEY}`;
  }

  const resp = await fetch(url, { headers });
  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`CryptoCompare HTTP ${resp.status} for ${base}USD`);
  }
  if (json.Response !== "Success") {
    throw new Error(`CryptoCompare: ${json.Message || "Unknown error"} for ${base}USD`);
  }

  const arr = json?.Data?.Data;
  if (!Array.isArray(arr) || arr.length < 20) {
    throw new Error(`Not enough data for ${base}USD`);
  }

  const closes = arr
    .map(d => Number(d.close))
    .filter(x => Number.isFinite(x) && x > 0);

  if (closes.length < 20) throw new Error(`Invalid closes for ${base}USD`);
  return closes;
}

async function fetchDailyClosesUSD(base, limitCloses, retries = 1) {
  const key = `${base}:${limitCloses}`;
  const hit = closesCache.get(key);
  if (hit && Date.now() - hit.at < CLOSES_TTL_MS) return hit.closes;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const closes = await ccHistodayUSD(base, limitCloses);
      closesCache.set(key, { at: Date.now(), closes });
      return closes;
    } catch (e) {
      lastErr = e;
      // Only rate limits are worth retrying; other errors won't self-heal
      if (!/rate limit|429/i.test(e.message)) break;
    }
  }

  // Expired cache beats a dead response for daily data
  if (hit) return hit.closes;
  throw lastErr;
}

/** ========== MAIN RANK ENDPOINT ========== */
app.post("/rank", async (req, res) => {
  try {
    const { tickers, lookbackDays = 90 } = req.body || {};
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({ error: "tickers must be a non-empty array" });
    }

    // ✅ LOOKBACK REALLY APPLIED HERE
    const lookback = Math.max(Number(lookbackDays) || 90, 20);
    const limitCloses = lookback + 1; // need +1 closes to create lookback returns

    // Benchmarks in USD — the whole request dies without these, so retry harder
    const [btcCloses, ethCloses] = await Promise.all([
      fetchDailyClosesUSD("BTC", limitCloses, 3),
      fetchDailyClosesUSD("ETH", limitCloses, 3),
    ]);

    const btcR = logReturns(btcCloses).slice(-lookback);
    const ethR = logReturns(ethCloses).slice(-lookback);

    const rows = [];

    for (const t of tickers) {
      const base = parseBaseSymbol(t);
      if (!base) continue;

      try {
        await sleep(50); // pace requests so we don't burst the rate limiter
        const closes = await fetchDailyClosesUSD(base, limitCloses);
        const r = logReturns(closes).slice(-lookback);

        const bBTC = beta(r, btcR);
        const bETH = beta(r, ethR);

        // ✅ YOUR RANKING: highest average abs beta
        const score = (bBTC == null || bETH == null)
          ? null
          : (Math.abs(bBTC) + Math.abs(bETH)) / 2;

        rows.push({
          ticker: String(t).trim().toUpperCase(),
          base,
          betaBTC: bBTC,
          betaETH: bETH,
          score
        });
      } catch (e) {
        rows.push({
          ticker: String(t).trim().toUpperCase(),
          base,
          betaBTC: null,
          betaETH: null,
          score: null,
          error: e.message
        });
      }
    }

    rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    rows.forEach((r, i) => (r.rank = i + 1));

    res.json({ timeframe: "1D", lookbackDays: lookback, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** ========== START SERVER ========== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
  console.log(
    process.env.CRYPTOCOMPARE_API_KEY
      ? "CRYPTOCOMPARE_API_KEY is set"
      : "WARNING: CRYPTOCOMPARE_API_KEY not set — keyless calls are rate-limited/rejected by CryptoCompare"
  );
});
