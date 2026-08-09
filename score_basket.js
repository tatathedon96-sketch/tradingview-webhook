// ── Shared TPI basket applied to any instrument, USD + BTC + ETH ──
// One fixed basket (the ETHBTC basket's indicators + settings), fanned across all
// tokens. USD = score the token's USD bars directly. BTC/ETH = synthesize
// TOKEN/BTC and TOKEN/ETH by dividing the token's USD bars by a BTC/USD (resp.
// ETH/USD) benchmark fetched ONCE and reused for every coin — full coverage, and
// far fewer fetches than pulling TOKENBTC / TOKENETH pairs.
//
// All indicators are single-timeframe (1D, or a folded 2D copy), so every
// instrument needs just ONE 1D fetch. (Pine 7, the old multi-TF member, was
// dropped: it needed per-ticker 3D/4H settings that can't be shared universe-wide.)

const { fetchDailyPair, aggregate } = require("./fetch_ohlc");
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
const BASKET_NAMES = BASKET.map(x => x.name);

const lastVal = a => (a && a.length ? a[a.length - 1] : null);

// Score from 1D bars: each indicator runs on 1D (or a folded 2D copy).
function scoreBars(bars1d) {
  const byTf = new Map([[1, bars1d]]);
  const signals = BASKET.map(ind => {
    if (!byTf.has(ind.tf)) byTf.set(ind.tf, aggregate(bars1d, ind.tf));
    return { name: ind.name, sig: lastVal(ind.fn(byTf.get(ind.tf))) };
  });
  const valid = signals.filter(s => s.sig != null);
  const score = valid.length ? valid.reduce((s, x) => s + x.sig, 0) / valid.length : null;
  return { signals, score };
}

// Synthesize TOKEN/BENCH ratio bars, aligned by timestamp. High/low use the
// cross bounds (tokHigh/benchLow, tokLow/benchHigh) — a slight over-estimate of
// the ratio's true range, fine for trend scoring.
function synthRatio(tok, bench, alignByDay = true) {
  // Match by exact timestamp, falling back to UTC-day bucket so tokens fetched
  // from a different exchange than the benchmark (slightly different bar times)
  // still align. Day alignment is safe for >=1-day bars.
  const exact = new Map(bench.map(b => [b.t, b]));
  const day = alignByDay ? new Map(bench.map(b => [Math.floor(b.t / 86400000), b])) : null;
  const out = [];
  for (const t of tok) {
    const b = exact.get(t.t) || (day && day.get(Math.floor(t.t / 86400000)));
    if (!b || !(b.open > 0 && b.close > 0 && b.high > 0 && b.low > 0)) continue;
    out.push({ t: t.t, open: t.open / b.open, high: t.high / b.low, low: t.low / b.high, close: t.close / b.close, vol: t.vol });
  }
  return out;
}

// USD benchmark (BTC/USD, ETH/USD, …) at 1D — each pair fetched once and reused
// for every coin (3h TTL). Used to synthesize TOKEN/BTC and TOKEN/ETH.
const _bench = new Map();
async function usdBench(pair) {
  const c = _bench.get(pair);
  if (c && Date.now() - c.at < 3 * 3600 * 1000) return c;
  const { bars } = await fetchDailyPair(pair, 400);
  const b = { at: Date.now(), d1: bars };
  _bench.set(pair, b);
  return b;
}

// Denominate a token in a benchmark (e.g. BTCUSDT, ETHUSDT): synthesize the
// TOKEN/BENCH ratio from the token's USD bars and score the basket on it.
async function denominate(tok, benchPair) {
  if (!tok) throw new Error("no USD data");
  const bench = await usdBench(benchPair);
  const r1 = synthRatio(tok.d1, bench.d1, true);
  if (r1.length < 30) throw new Error("ratio too short");
  return scoreBars(r1);
}

// Score a token on USD (direct) and BTC + ETH (synthesized from its USD bars).
async function scoreToken(base) {
  const B = String(base).trim().toUpperCase();
  const result = { base: B, usd: null, btc: null, eth: null };

  let tok;
  try {
    const { bars } = await fetchDailyPair(B + "USDT", 400);
    tok = { d1: bars };
    result.usd = scoreBars(tok.d1);
  } catch (e) {
    result.usd = { error: e.message };
  }

  // BTC denomination (skip BTC/BTC).
  if (B === "BTC") result.btc = { error: "n/a (BTC/BTC)" };
  else { try { result.btc = await denominate(tok, "BTCUSDT"); } catch (e) { result.btc = { error: e.message }; } }

  // ETH denomination (skip ETH/ETH).
  if (B === "ETH") result.eth = { error: "n/a (ETH/ETH)" };
  else { try { result.eth = await denominate(tok, "ETHUSDT"); } catch (e) { result.eth = { error: e.message }; } }

  return result;
}

module.exports = { BASKET, BASKET_NAMES, scoreBars, synthRatio, scoreToken };

// Demo: `node score_basket.js SOL AVAX LINK`
if (require.main === module) {
  (async () => {
    const tokens = process.argv.slice(2).length ? process.argv.slice(2) : ["SOL", "AVAX", "LINK"];
    const fmt = s => (s == null ? "  -  " : (s > 0 ? "+" : "") + s.toFixed(2));
    const cell = side => (side && !side.error ? fmt(side.score) : "err");
    console.log(`\nShared TPI basket (${BASKET_NAMES.length} indicators) — USD, BTC & ETH (synth)\n`);
    console.log("  Token   USD      BTC      ETH");
    console.log("  " + "-".repeat(35));
    for (const base of tokens) {
      const r = await scoreToken(base);
      console.log(`  ${base.padEnd(6)}  ${String(cell(r.usd)).padStart(6)}  ${String(cell(r.btc)).padStart(6)}  ${String(cell(r.eth)).padStart(6)}`);
    }
    console.log("");
  })().catch(e => { console.error("ERR:", e.message); process.exit(1); });
}
