// ── Shared TPI basket applied to any instrument ──
// One fixed basket (the ETHBTC basket's indicators + settings), fanned out across
// all tokens on both USD and BTC. Each entry: name, timeframe, and fn(bars)->signal series.
// WRB and Pine 7 will slot in here once their sources/settings are finalized.

const { fetchDailyPair, fetchInterval, aggregate } = require("./fetch_ohlc");
const I = require("./indicators");

// Single-timeframe indicators (run on 1D bars, or a folded 2D copy).
const BASKET = [
  { name: "Enhanced Keltner Trend", tf: 1, fn: b => I.ekt(b, { atrBool: false, atrLen: 1, atrMult: 0.161, maLen: 42, maType: "SMA", srcKey: "close" }) },
  { name: "Median Supertrend",      tf: 1, fn: b => I.medianST(b, { atrPeriod: 100, mul: 1.26, medianLen: 30, srcKey: "close" }) },
  { name: "Weighted Regression Bands", tf: 1, fn: b => I.wrb(b, { len: 40, weighting: "Smooth", filterStrength: 0.11, method: "Linear Regression" }) },
  { name: "P-Motion Trend",         tf: 1, fn: b => I.pMotion(b, { emaLen: 20, sdLength: 30, multUp: 1.69, multDn: 1.45, srcKey: "close", demaLen: 3, prcLen: 3 }) },
  { name: "Kalman Hull RSI",        tf: 1, fn: b => I.kalmanHullRSI(b, { srcKey: "close", measNoise: 3, processNoise: 0.01, rsiPeriod: 12 }) },
  { name: "ROC-Weighted MA Osc",    tf: 2, fn: b => I.rocWMA(b, { rocLen: 19, maLen: 10, sigLen: 9, srcKey: "close", neutralThr: 0.75, maType: "TEMA" }) },
];
// Pine 7 is multi-timeframe (3D bands + 4H ema200), handled separately below.
const BASKET_NAMES = [...BASKET.map(x => x.name), "Pine 7"];

const lastVal = a => a[a.length - 1];

// Score one instrument (e.g. "SOLUSDT" or "SOLBTC"): run the full basket, return
// per-indicator signals + the averaged TPI score (over indicators that computed).
async function scoreInstrument(pair, limit = 400) {
  let bars;
  try { ({ bars } = await fetchDailyPair(pair, limit)); }
  catch (e) { return { pair, error: e.message }; }

  const byTf = new Map([[1, bars]]);
  const signals = BASKET.map(ind => {
    if (!byTf.has(ind.tf)) byTf.set(ind.tf, aggregate(bars, ind.tf));
    return { name: ind.name, sig: lastVal(ind.fn(byTf.get(ind.tf))) };
  });

  // Pine 7 — needs 3D + 4H resolutions; excluded from the average if data fails.
  try {
    const [{ bars: b3d }, { bars: b4h }] = await Promise.all([
      fetchInterval(pair, "3d", 400),
      fetchInterval(pair, "4h", 900),
    ]);
    signals.push({ name: "Pine 7", sig: lastVal(I.pine7Resolved(bars, b3d, b4h)) });
  } catch (e) {
    signals.push({ name: "Pine 7", sig: null, error: e.message });
  }

  const valid = signals.filter(s => s.sig != null);
  const score = valid.length ? valid.reduce((s, x) => s + x.sig, 0) / valid.length : null;
  return { pair, bars: bars.length, signals, score };
}

// Score a token on both USD and BTC.
async function scoreToken(base) {
  const [usd, btc] = await Promise.all([
    scoreInstrument(`${base}USDT`),
    scoreInstrument(base === "BTC" ? "BTCUSDT" : `${base}BTC`),
  ]);
  return { base, usd, btc };
}

module.exports = { BASKET, BASKET_NAMES, scoreInstrument, scoreToken };

// Demo: `node score_basket.js SOL AVAX LINK DOGE ADA`
if (require.main === module) {
  (async () => {
    const tokens = process.argv.slice(2).length ? process.argv.slice(2) : ["SOL", "AVAX", "LINK", "DOGE", "ADA"];
    const fmt = s => (s == null ? "  -  " : (s > 0 ? "+" : "") + s.toFixed(2));
    console.log(`\nShared TPI basket (${BASKET.length} indicators) — USD & BTC scores\n`);
    console.log("  Token   USD score   BTC score");
    console.log("  " + "-".repeat(34));
    for (const base of tokens) {
      const r = await scoreToken(base);
      const u = r.usd.error ? "err" : fmt(r.usd.score);
      const b = r.btc.error ? "err" : fmt(r.btc.score);
      console.log(`  ${base.padEnd(6)}  ${String(u).padStart(7)}    ${String(b).padStart(7)}`);
    }
    console.log("\n  score = mean of the basket's +1/-1 signals (range -1..+1)\n");
  })().catch(e => { console.error("ERR:", e.message); process.exit(1); });
}
