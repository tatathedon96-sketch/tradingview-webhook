// ── Shared TPI basket applied to any instrument, USD + BTC ──
// One fixed basket (the ETHBTC basket's indicators + settings), fanned across all
// tokens. USD = score the token's USD bars directly. BTC = synthesize TOKEN/BTC by
// dividing the token's USD bars by the BTC/USD benchmark (fetched ONCE, reused for
// every coin) — full BTC coverage, and fewer fetches than pulling TOKENBTC pairs.

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
// Pine 7 is multi-timeframe (3D bands + 4H ema200), computed separately.
const BASKET_NAMES = [...BASKET.map(x => x.name), "Pine 7"];

const lastVal = a => (a && a.length ? a[a.length - 1] : null);

// Score from pre-fetched bars: 1D (+ folded 2D) for the basket, 3D & 4H for Pine 7.
function scoreBars(bars1d, bars3d, bars4h) {
  const byTf = new Map([[1, bars1d]]);
  const signals = BASKET.map(ind => {
    if (!byTf.has(ind.tf)) byTf.set(ind.tf, aggregate(bars1d, ind.tf));
    return { name: ind.name, sig: lastVal(ind.fn(byTf.get(ind.tf))) };
  });
  let pine = null;
  try { if (bars3d && bars4h) pine = lastVal(I.pine7Resolved(bars1d, bars3d, bars4h)); } catch (e) {}
  signals.push({ name: "Pine 7", sig: pine });

  const valid = signals.filter(s => s.sig != null);
  const score = valid.length ? valid.reduce((s, x) => s + x.sig, 0) / valid.length : null;
  return { signals, score };
}

// Synthesize TOKEN/BTC ratio bars, aligned by timestamp. High/low use the
// cross bounds (tokHigh/btcLow, tokLow/btcHigh) — a slight over-estimate of the
// ratio's true range, fine for trend scoring.
function synthRatio(tok, btc, alignByDay = true) {
  // Match by exact timestamp, falling back to UTC-day bucket so tokens fetched
  // from a different exchange than BTC (slightly different bar times) still align.
  // Day alignment is safe for >=1-day bars (1D/3D); 4H must use exact timestamps.
  const exact = new Map(btc.map(b => [b.t, b]));
  const day = alignByDay ? new Map(btc.map(b => [Math.floor(b.t / 86400000), b])) : null;
  const out = [];
  for (const t of tok) {
    const b = exact.get(t.t) || (day && day.get(Math.floor(t.t / 86400000)));
    if (!b || !(b.open > 0 && b.close > 0 && b.high > 0 && b.low > 0)) continue;
    out.push({ t: t.t, open: t.open / b.open, high: t.high / b.low, low: t.low / b.high, close: t.close / b.close, vol: t.vol });
  }
  return out;
}

// BTC/USD benchmark at 1D/3D/4H — fetched once, reused for every coin (3h TTL).
let _btc = null;
async function btcBench() {
  if (_btc && Date.now() - _btc.at < 3 * 3600 * 1000) return _btc;
  const [d1, d3, h4] = await Promise.all([
    fetchDailyPair("BTCUSDT", 400),
    fetchInterval("BTCUSDT", "3d", 400).catch(() => ({ bars: null })),
    fetchInterval("BTCUSDT", "4h", 900).catch(() => ({ bars: null })),
  ]);
  _btc = { at: Date.now(), d1: d1.bars, d3: d3.bars, h4: h4.bars };
  return _btc;
}

// Score a token on USD (direct) and BTC (synthesized from the token's USD bars).
async function scoreToken(base) {
  const B = String(base).trim().toUpperCase();
  const result = { base: B, usd: null, btc: null };

  let tok;
  try {
    const [d1, d3, h4] = await Promise.all([
      fetchDailyPair(B + "USDT", 400),
      fetchInterval(B + "USDT", "3d", 400).catch(() => ({ bars: null })),
      fetchInterval(B + "USDT", "4h", 900).catch(() => ({ bars: null })),
    ]);
    tok = { d1: d1.bars, d3: d3.bars, h4: h4.bars };
    result.usd = scoreBars(tok.d1, tok.d3, tok.h4);
  } catch (e) {
    result.usd = { error: e.message };
  }

  if (B === "BTC") { result.btc = { error: "n/a (BTC/BTC)" }; return result; }
  try {
    if (!tok) throw new Error("no USD data");
    const bench = await btcBench();
    const r1 = synthRatio(tok.d1, bench.d1, true);
    if (r1.length < 30) throw new Error("ratio too short");
    const r3 = tok.d3 && bench.d3 ? synthRatio(tok.d3, bench.d3, true) : null;
    const r4 = tok.h4 && bench.h4 ? synthRatio(tok.h4, bench.h4, false) : null;
    result.btc = scoreBars(r1, r3, r4);
  } catch (e) {
    result.btc = { error: e.message };
  }
  return result;
}

module.exports = { BASKET, BASKET_NAMES, scoreBars, synthRatio, scoreToken };

// Demo: `node score_basket.js SOL AVAX LINK`
if (require.main === module) {
  (async () => {
    const tokens = process.argv.slice(2).length ? process.argv.slice(2) : ["SOL", "AVAX", "LINK"];
    const fmt = s => (s == null ? "  -  " : (s > 0 ? "+" : "") + s.toFixed(2));
    console.log(`\nShared TPI basket (${BASKET_NAMES.length} indicators) — USD & BTC (synth)\n`);
    console.log("  Token   USD      BTC");
    console.log("  " + "-".repeat(26));
    for (const base of tokens) {
      const r = await scoreToken(base);
      const u = r.usd && !r.usd.error ? fmt(r.usd.score) : "err";
      const b = r.btc && !r.btc.error ? fmt(r.btc.score) : "err";
      console.log(`  ${base.padEnd(6)}  ${String(u).padStart(6)}  ${String(b).padStart(6)}`);
    }
    console.log("");
  })().catch(e => { console.error("ERR:", e.message); process.exit(1); });
}
