const express = require("express");
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("Server is running"));

function mean(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }
function variance(arr){
  const m = mean(arr);
  return arr.reduce((s,x)=>s+(x-m)*(x-m),0)/(arr.length-1);
}
function covariance(a,b){
  const ma = mean(a), mb = mean(b);
  let s = 0;
  for(let i=0;i<a.length;i++) s += (a[i]-ma)*(b[i]-mb);
  return s/(a.length-1);
}
function logReturns(closes){
  const r = [];
  for(let i=1;i<closes.length;i++){
    r.push(Math.log(closes[i]/closes[i-1]));
  }
  return r;
}

// Fetch daily closes from Binance
async function fetchDailyCloses(symbol, limit=120){
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`;
  const resp = await fetch(url);
  if(!resp.ok) throw new Error(`Binance error ${resp.status} for ${symbol}`);
  const data = await resp.json();
  // kline: [ openTime, open, high, low, close, volume, closeTime, ...]
  return data.map(k => Number(k[4]));
}

function beta(assetR, benchR){
  const n = Math.min(assetR.length, benchR.length);
  const a = assetR.slice(assetR.length - n);
  const b = benchR.slice(benchR.length - n);
  const varB = variance(b);
  if(!isFinite(varB) || varB === 0) return null;
  return covariance(a,b)/varB;
}

// MAIN: rank endpoint
app.post("/rank", async (req, res) => {
  try{
    const { tickers, lookbackDays = 90 } = req.body || {};
    if(!Array.isArray(tickers) || tickers.length === 0){
      return res.status(400).json({ error: "tickers must be a non-empty array" });
    }

    const limit = Math.max(lookbackDays + 30, 120); // buffer
    const [btcCloses, ethCloses] = await Promise.all([
      fetchDailyCloses("BTCUSDT", limit),
      fetchDailyCloses("ETHUSDT", limit),
    ]);

    const btcR = logReturns(btcCloses);
    const ethR = logReturns(ethCloses);

    const rows = [];
    for(const t of tickers){
      const sym = String(t).trim().toUpperCase();
      if(!sym) continue;

      try{
        const closes = await fetchDailyCloses(sym, limit);
        const r = logReturns(closes);

        const bBTC = beta(r, btcR);
        const bETH = beta(r, ethR);

        // Ranking rule (edit this):
        // example score = average absolute beta (more “market-sensitive” higher)
        const score = (bBTC == null || bETH == null) ? null : (Math.abs(bBTC) + Math.abs(bETH)) / 2;

        rows.push({
          ticker: sym,
          betaBTC: bBTC,
          betaETH: bETH,
          score
        });
      } catch(e){
        rows.push({ ticker: sym, betaBTC: null, betaETH: null, score: null, error: e.message });
      }
    }

    // Sort: highest score first; nulls last
    rows.sort((a,b)=>{
      const ax = a.score ?? -Infinity;
      const bx = b.score ?? -Infinity;
      return bx - ax; // highest first
    });

    // add rank
    rows.forEach((r,i)=> r.rank = i+1);

    res.json({ lookbackDays, rows });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server running on port", PORT));
