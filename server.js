const express = require("express");
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("Server is running"));

/** ---------- math helpers ---------- */
function mean(a){ return a.reduce((s,x)=>s+x,0)/a.length; }
function variance(a){
  const m = mean(a);
  return a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1);
}
function covariance(a,b){
  const ma=mean(a), mb=mean(b);
  let s=0; for(let i=0;i<a.length;i++) s += (a[i]-ma)*(b[i]-mb);
  return s/(a.length-1);
}
function logReturns(closes){
  const r=[]; for(let i=1;i<closes.length;i++) r.push(Math.log(closes[i]/closes[i-1]));
  return r;
}
function beta(assetR, benchR){
  const n = Math.min(assetR.length, benchR.length);
  const a = assetR.slice(-n);
  const b = benchR.slice(-n);
  const vb = variance(b);
  if (!isFinite(vb) || vb === 0) return null;
  return covariance(a,b) / vb;
}
function parseBaseSymbol(ticker){
  const s = String(ticker||"").trim().toUpperCase();
  for (const q of ["USDT","USD","USDC","BTC","ETH"]) {
    if (s.endsWith(q) && s.length > q.length) return { base: s.slice(0,-q.length), quote: q };
  }
  // default assume USDT quote
  return { base: s, quote: "USDT" };
}

/** ---------- CryptoCompare daily closes ---------- */
async function fetchDailyClosesCC(base, quote, limit=120){
  const url =
    `https://min-api.cryptocompare.com/data/v2/histoday` +
    `?fsym=${encodeURIComponent(base)}` +
    `&tsym=${encodeURIComponent(quote)}` +
    `&limit=${limit}`;

  const headers = {};
  if (process.env.CRYPTOCOMPARE_API_KEY) {
    headers["authorization"] = `Apikey ${process.env.CRYPTOCOMPARE_API_KEY}`;
  }

  const resp = await fetch(url, { headers });
  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) throw new Error(`CryptoCompare HTTP ${resp.status} for ${base}${quote}`);
  if (json.Response !== "Success") throw new Error(`CryptoCompare: ${json.Message || "Unknown error"} for ${base}${quote}`);

  const arr = json?.Data?.Data;
  if (!Array.isArray(arr) || arr.length < 20) throw new Error(`Not enough data for ${base}${quote}`);

  return arr.map(d => Number(d.close)).filter(x => Number.isFinite(x) && x > 0);
}

/** ---------- Rank endpoint ---------- */
app.post("/rank", async (req, res) => {
  try {
    const { tickers, lookbackDays = 90 } = req.body || {};
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({ error: "tickers must be a non-empty array" });
    }

    const limit = Math.max(lookbackDays + 10, 120);

    // Benchmarks vs USD (consistent)
    const [btcCloses, ethCloses] = await Promise.all([
      fetchDailyClosesCC("BTC", "USD", limit),
      fetchDailyClosesCC("ETH", "USD", limit),
    ]);

    const btcR = logReturns(btcCloses);
    const ethR = logReturns(ethCloses);

    const rows = [];
    for (const t of tickers) {
      const { base } = parseBaseSymbol(t);
      if (!base) continue;

      try {
        // asset returns in USD for beta vs BTC/ETH in USD
        const closes = await fetchDailyClosesCC(base, "USD", limit);
        const r = logReturns(closes);

        const bBTC = beta(r, btcR);
        const bETH = beta(r, ethR);

        // ✅ Your rule: highest average absolute beta
        const score = (bBTC == null || bETH == null) ? null : (Math.abs(bBTC) + Math.abs(bETH)) / 2;

        rows.push({ ticker: String(t).toUpperCase(), base, betaBTC: bBTC, betaETH: bETH, score });
      } catch (e) {
        rows.push({ ticker: String(t).toUpperCase(), base, betaBTC: null, betaETH: null, score: null, error: e.message });
      }
    }

    rows.sort((a,b)=> (b.score ?? -Infinity) - (a.score ?? -Infinity));
    rows.forEach((r,i)=> r.rank = i+1);

    res.json({ lookbackDays, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server running on port", PORT));
