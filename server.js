const express = require("express");
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("Server is running"));

/** --------- Math helpers ---------- */
function mean(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }
function variance(arr) {
  const m = mean(arr);
  return arr.reduce((s,x)=>s+(x-m)*(x-m),0)/(arr.length-1);
}
function covariance(a,b) {
  const ma = mean(a), mb = mean(b);
  let s = 0;
  for (let i=0;i<a.length;i++) s += (a[i]-ma)*(b[i]-mb);
  return s/(a.length-1);
}
function logReturns(closes) {
  const r = [];
  for (let i=1;i<closes.length;i++) r.push(Math.log(closes[i]/closes[i-1]));
  return r;
}
function beta(assetR, benchR) {
  const n = Math.min(assetR.length, benchR.length);
  const a = assetR.slice(assetR.length - n);
  const b = benchR.slice(benchR.length - n);
  const varB = variance(b);
  if (!isFinite(varB) || varB === 0) return null;
  return covariance(a, b) / varB;
}
function parseBaseSymbol(ticker) {
  const s = String(ticker || "").trim().toUpperCase();
  if (!s) return "";
  // common quote suffixes
  for (const q of ["USDT","USD","USDC","BTC","ETH"]) {
    if (s.endsWith(q) && s.length > q.length) return s.slice(0, -q.length);
  }
  return s; // already base symbol
}

/** --------- CoinMarketCap helpers ---------- */
const CMC_KEY = process.env.CMC_API_KEY;
if (!CMC_KEY) {
  console.warn("CMC_API_KEY is not set (Railway Variables). /rank will fail until set.");
}

const CMC_HEADERS = {
  "X-CMC_PRO_API_KEY": CMC_KEY || "",
  "Accept": "application/json"
};

// simple in-memory cache to reduce calls
const symbolToIdCache = new Map();

async function cmcGetJson(url) {
  const resp = await fetch(url, { headers: CMC_HEADERS });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`CMC non-JSON response: ${text.slice(0,200)}`); }

  if (!resp.ok) {
    const msg = json?.status?.error_message || `HTTP ${resp.status}`;
    throw new Error(`CMC error: ${msg}`);
  }
  if (json?.status?.error_code && json.status.error_code !== 0) {
    throw new Error(`CMC error: ${json.status.error_message || json.status.error_code}`);
  }
  return json;
}

async function getCmcIdForSymbol(symbol) {
  const sym = symbol.toUpperCase();
  if (symbolToIdCache.has(sym)) return symbolToIdCache.get(sym);

  const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/map?symbol=${encodeURIComponent(sym)}&listing_status=active`;
  const json = await cmcGetJson(url);

  const arr = json?.data;
  if (!Array.isArray(arr) || arr.length === 0) throw new Error(`CMC map: no id for ${sym}`);

  // Pick the first active match (usually correct). If there are multiple, this still works for major coins.
  const id = arr[0].id;
  symbolToIdCache.set(sym, id);
  return id;
}

async function fetchDailyClosesCMC(id, timeStartISO, timeEndISO) {
  // CMC OHLCV historical endpoint (plan must allow it)
  const url =
    `https://pro-api.coinmarketcap.com/v2/cryptocurrency/ohlcv/historical` +
    `?id=${id}&convert=USD&time_start=${encodeURIComponent(timeStartISO)}&time_end=${encodeURIComponent(timeEndISO)}` +
    `&interval=daily`;

  const json = await cmcGetJson(url);

  // Response shape: data.quotes[] each has quote.USD.close
  const quotes = json?.data?.quotes;
  if (!Array.isArray(quotes) || quotes.length < 10) throw new Error(`CMC OHLCV: not enough data for id ${id}`);

  const closes = quotes
    .map(q => q?.quote?.USD?.close)
    .map(x => Number(x))
    .filter(x => Number.isFinite(x) && x > 0);

  if (closes.length < 10) throw new Error(`CMC OHLCV: invalid closes for id ${id}`);
  return closes;
}

/** --------- Rank endpoint ---------- */
app.post("/rank", async (req, res) => {
  try {
    const { tickers, lookbackDays = 90 } = req.body || {};
    if (!CMC_KEY) return res.status(500).json({ error: "CMC_API_KEY not set in Railway Variables" });

    if (!Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({ error: "tickers must be a non-empty array" });
    }

    const now = new Date();
    const endISO = now.toISOString();
    const start = new Date(now.getTime() - (lookbackDays + 5) * 24 * 60 * 60 * 1000);
    const startISO = start.toISOString();

    // Benchmarks
    const [btcId, ethId] = await Promise.all([
      getCmcIdForSymbol("BTC"),
      getCmcIdForSymbol("ETH"),
    ]);

    const [btcCloses, ethCloses] = await Promise.all([
      fetchDailyClosesCMC(btcId, startISO, endISO),
      fetchDailyClosesCMC(ethId, startISO, endISO),
    ]);

    const btcR = logReturns(btcCloses);
    const ethR = logReturns(ethCloses);

    const rows = [];
    for (const t of tickers) {
      const base = parseBaseSymbol(t);
      if (!base) continue;

      try {
        const id = await getCmcIdForSymbol(base);
        const closes = await fetchDailyClosesCMC(id, startISO, endISO);
        const r = logReturns(closes);

        const bBTC = beta(r, btcR);
        const bETH = beta(r, ethR);

        // ✅ your chosen ranking: highest average absolute beta
        const score = (bBTC == null || bETH == null) ? null : (Math.abs(bBTC) + Math.abs(bETH)) / 2;

        rows.push({ ticker: String(t).toUpperCase(), base, betaBTC: bBTC, betaETH: bETH, score });
      } catch (e) {
        rows.push({ ticker: String(t).toUpperCase(), base, betaBTC: null, betaETH: null, score: null, error: e.message });
      }
    }

    rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    rows.forEach((r, i) => r.rank = i + 1);

    res.json({ lookbackDays, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Keep your existing endpoints if you want **/
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

app.post("/tradingview", (req, res) => {
  console.log("TradingView Alert:", req.body);
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server running on port", PORT));
