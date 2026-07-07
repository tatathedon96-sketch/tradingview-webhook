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

/** ========== DAILY CLOSES (USDT ≈ USD) — KEYLESS EXCHANGE PUBLIC APIs ==========
 * CryptoCompare's free tier dropped to 100 calls/month (a full run needs ~160),
 * so daily closes now come from exchange public candle endpoints instead.
 * No API keys, no monthly quotas — only per-IP rate limits we stay under.
 * Fallback chain per symbol; the working source is remembered per base.
 */
const CLOSES_TTL_MS = 3 * 60 * 60 * 1000; // daily candles only roll once a day
const closesCache = new Map(); // "BASE:limitCloses" -> { at, closes }
const sourceMemo = new Map();  // "BASE" -> source name that worked last time

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// Each source resolves to closes in ascending time order, or throws.
const SOURCES = {
  async kucoin(base, limitCloses) {
    const end = Math.floor(Date.now() / 1000);
    const start = end - (limitCloses + 2) * 86400;
    const j = await getJSON(
      `https://api.kucoin.com/api/v1/market/candles?type=1day&symbol=${base}-USDT&startAt=${start}&endAt=${end}`
    );
    if (j.code !== "200000" || !Array.isArray(j.data)) throw new Error(`kucoin: ${j.msg || j.code}`);
    return j.data.map(row => Number(row[2])).reverse(); // newest-first -> ascending, close at [2]
  },
  async okx(base, limitCloses) {
    const j = await getJSON(
      `https://www.okx.com/api/v5/market/candles?instId=${base}-USDT&bar=1Dutc&limit=${Math.min(limitCloses, 300)}`
    );
    if (j.code !== "0" || !Array.isArray(j.data)) throw new Error(`okx: ${j.msg || j.code}`);
    return j.data.map(row => Number(row[4])).reverse(); // newest-first -> ascending, close at [4]
  },
  async binance(base, limitCloses) {
    const j = await getJSON(
      `https://api.binance.com/api/v3/klines?symbol=${base}USDT&interval=1d&limit=${Math.min(limitCloses, 1000)}`
    );
    if (!Array.isArray(j)) throw new Error(`binance: ${(j && j.msg) || "bad response"}`);
    return j.map(row => Number(row[4])); // ascending, close at [4]
  },
  async gate(base, limitCloses) {
    const j = await getJSON(
      `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${base}_USDT&interval=1d&limit=${Math.min(limitCloses, 1000)}`
    );
    if (!Array.isArray(j)) throw new Error(`gate: ${(j && j.message) || "bad response"}`);
    return j.map(row => Number(row[2])); // ascending, close at [2]
  },
  async mexc(base, limitCloses) {
    const j = await getJSON(
      `https://api.mexc.com/api/v3/klines?symbol=${base}USDT&interval=1d&limit=${Math.min(limitCloses, 1000)}`
    );
    if (!Array.isArray(j)) throw new Error(`mexc: ${(j && j.msg) || "bad response"}`);
    return j.map(row => Number(row[4])); // ascending, close at [4]
  },
};
const SOURCE_ORDER = ["kucoin", "okx", "binance", "gate", "mexc"];

function validCloses(arr) {
  const closes = (arr || []).filter(x => Number.isFinite(x) && x > 0);
  return closes.length >= 20 ? closes : null;
}

async function fetchFromAnySource(base, limitCloses) {
  const remembered = sourceMemo.get(base);
  const order = remembered
    ? [remembered, ...SOURCE_ORDER.filter(s => s !== remembered)]
    : SOURCE_ORDER;

  const errors = [];
  for (const name of order) {
    try {
      const closes = validCloses(await SOURCES[name](base, limitCloses));
      if (!closes) throw new Error(`${name}: not enough data`);
      sourceMemo.set(base, name);
      return closes.slice(-limitCloses);
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(`No daily data for ${base}-USDT on any source (${errors.join("; ")})`);
}

async function fetchDailyClosesUSD(base, limitCloses, retries = 1) {
  const key = `${base}:${limitCloses}`;
  const hit = closesCache.get(key);
  if (hit && Date.now() - hit.at < CLOSES_TTL_MS) return hit.closes;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const closes = await fetchFromAnySource(base, limitCloses);
      closesCache.set(key, { at: Date.now(), closes });
      return closes;
    } catch (e) {
      lastErr = e;
      // Only rate limits are worth retrying; unknown symbols won't self-heal
      if (!/rate limit|429|too many/i.test(e.message)) break;
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

    // Benchmarks — the whole request dies without these, so retry harder
    const [btcCloses, ethCloses] = await Promise.all([
      fetchDailyClosesUSD("BTC", limitCloses, 3),
      fetchDailyClosesUSD("ETH", limitCloses, 3),
    ]);

    const btcR = logReturns(btcCloses).slice(-lookback);
    const ethR = logReturns(ethCloses).slice(-lookback);

    const rows = [];
    const queue = tickers.slice();

    // Small worker pool: ~160 tickers sequentially would flirt with the
    // Apps Script UrlFetch timeout; 4 workers keeps us well under it while
    // staying inside every exchange's public per-IP rate limits.
    async function worker() {
      while (queue.length > 0) {
        const t = queue.shift();
        const base = parseBaseSymbol(t);
        if (!base) continue;

        try {
          await sleep(25); // stagger so requests don't burst
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
    }
    await Promise.all(Array.from({ length: 4 }, worker));

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
  console.log("Data sources: kucoin, okx, binance, gate, mexc (keyless public candle APIs)");
});
