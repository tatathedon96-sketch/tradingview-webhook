// ── Ratio TPI blocks for the RSPS "2 - Conservative Trend" tab ──
// Scores the six major-vs-major ratio TPIs (ETHBTC, SOLETH, SOLBTC, HYPEBTC,
// HYPEETH, HYPESOL) with each block's OWN indicator list and inputs, exactly as
// typed in the sheet. Apps Script (RATIO_TPI_AUTOFILL) writes the "auto" rows
// into the sheet's Score column and raises an alarm on everything else.
//
// Data:
//   - ETHBTC / SOLETH / SOLBTC: Binance's real pair when reachable; otherwise a
//     synthetic ratio from USDT pairs (never a thin OKX/KuCoin cross pair).
//   - HYPE*: KUCOIN:HYPEUSDT (the longest HYPE history) over the major's USDT pair,
//     the same symbol expression the TradingView charts use.
//
// Synthetic ratio bars are built component-wise, the way TradingView draws a
// spread chart (open/open, high/high, low/low, close/close). The older cross-bound
// form (high/low, low/high) inflates the true range, and every ATR-based
// indicator (Median ST, ST MA, EKT with ATR) then disagrees with the real pair on
// 30-60% of days. Component-wise matches the real pair on 98-100%.
//
// Scores use the last CLOSED daily bar, so a 4h refresh can't flip a cell back
// and forth while today's candle is still forming. `live` is the forming bar.

const { fetchDailyPair, fetchDailyFrom } = require("./fetch_ohlc");
const I = require("./indicators");

const DAY = 86400000;

const IND = {
  ekt42:   b => I.ekt(b, { atrBool: false, atrLen: 1, atrMult: 0.161, maLen: 42, maType: "SMA", srcKey: "close" }),
  ektVwma: b => I.ekt(b, { atrBool: true, atrLen: 20, atrMult: 1, maLen: 20, maType: "VWMA", srcKey: "close" }),
  medST:   b => I.medianST(b, { atrPeriod: 100, mul: 1.26, medianLen: 30, srcKey: "close" }),
  wrb40:   b => I.wrb(b, { len: 40, weighting: "Smooth", filterStrength: 0.11 }),
  wrb27:   b => I.wrb(b, { len: 27, weighting: "Smooth", filterStrength: 0.08 }),
  pMotion: b => I.pMotion(b, { emaLen: 20, sdLength: 30, multUp: 1.69, multDn: 1.45, srcKey: "close", demaLen: 3, prcLen: 3 }),
  khRsi:   b => I.kalmanHullRSI(b, { srcKey: "close", measNoise: 3, processNoise: 0.01, rsiPeriod: 12 }),
  rocWma:  b => I.rocWMA(b, { rocLen: 19, maLen: 10, sigLen: 9, srcKey: "close", neutralThr: 0.75, maType: "TEMA" }),
  stMaTma: b => I.stMA(b, { maType: "TMA", length: 100, atrPeriod: 44, atrMult: 1.51 }),
};

// Row names are the sheet's column-C text. mode:
//   auto  = ported with the sheet's inputs and validated -> written to the sheet
//   check = ported but not validated against TradingView -> compared, never written
//   null  = not ported -> the sheet keeps the hand-typed value (staleness-alarmed)
const BLOCKS = {
  ETHBTC: { pair: "ETHBTC", rows: [
    ["Enhanced Keltner Trend",     "ekt42",   1, "auto"],
    ["Median Supertrend",          "medST",   1, "auto"],
    ["Weighted Regression Bands",  "wrb40",   1, "auto"],
    ["P-Motion Trend",             "pMotion", 1, "auto"],
    ["Pine 7",                     null,      1, null],
    ["Kalman Hull RSI",            "khRsi",   1, "auto"],
    ["ROC-Weighted MA Oscillator", "rocWma",  2, "auto"],
  ]},
  SOLETH: { pair: "SOLETH", rows: [
    ["25-75 ST",                   null,      1, null],
    ["Weighted Regression Bands",  "wrb27",   1, "check"],   // sheet uses the ALMA method; port is Smooth-only
    ["EKT",                        "ektVwma", 2, "auto"],
    ["Pine 7",                     null,      2, null],
    ["Dema HMA Oscillator",        null,      1, null],
    ["Squeeze Momentum",           null,      2, null],
  ]},
  SOLBTC: { pair: "SOLBTC", rows: [
    ["EMD Trend",                  null,      1, null],
    ["ST MA",                      "stMaTma", 1, "auto"],
    ["Follow Line Trend Signal",   null,      2, null],
    ["Pine 7",                     null,      1, null],
    ["Dual-Phase Trend Regime",    null,      1, null],
    ["Savitzky Golay Median Filtered RSI", null, 1, null],
  ]},
  HYPEBTC: { hype: "BTCUSDT", rows: [
    ["Enhanced Keltner Trend",     "ekt42",   1, "auto"],
    ["Median Supertrend",          "medST",   1, "auto"],
    ["Weighted Regression Bands",  "wrb40",   1, "auto"],
    ["P-Motion Trend",             "pMotion", 1, "auto"],
    ["Kalman Hull RSI",            "khRsi",   1, "auto"],
    ["ROC-Weighted MA Oscillator", "rocWma",  2, "auto"],
  ]},
  HYPEETH: { hype: "ETHUSDT", rows: [
    ["EKT",                        "ektVwma", 2, "auto"],
    ["Median Supertrend",          "medST",   1, "auto"],
    ["Weighted Regression Bands",  "wrb40",   1, "auto"],
    ["ST MA",                      "stMaTma", 1, "auto"],
    ["Kalman Hull RSI",            "khRsi",   1, "auto"],
    ["ROC-Weighted MA Oscillator", "rocWma",  2, "auto"],
  ]},
  HYPESOL: { hype: "SOLUSDT", rows: [
    ["ST MA",                      "stMaTma", 1, "auto"],
    ["Median Supertrend",          "medST",   1, "auto"],
    ["P-Motion Trend",             "pMotion", 1, "auto"],
    ["Weighted Regression Bands",  "wrb40",   1, "auto"],
    ["Kalman Hull RSI",            "khRsi",   1, "auto"],
    ["ROC-Weighted MA Oscillator", "rocWma",  2, "auto"],
  ]},
};

// TradingView-style spread bars: each OHLC component divided separately, then
// high/low re-bounded so the bar stays well-formed.
function synthTV(tok, bench) {
  const byDay = new Map(bench.map(b => [Math.floor(b.t / DAY), b]));
  const out = [];
  for (const t of tok) {
    const b = byDay.get(Math.floor(t.t / DAY));
    if (!b || !(b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0)) continue;
    const o = t.open / b.open, h = t.high / b.high, l = t.low / b.low, c = t.close / b.close;
    out.push({ t: t.t, open: o, high: Math.max(o, h, l, c), low: Math.min(o, h, l, c), close: c, vol: t.vol });
  }
  return out;
}

// 2D bars anchored to the Unix epoch (day index parity), so the grouping does
// not shift with how many bars a source happened to return.
function aggregateAnchored(bars, n) {
  if (n <= 1) return bars.slice();
  const groups = new Map();
  for (const b of bars) {
    const k = Math.floor(Math.floor(b.t / DAY) / n);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  return [...groups.values()].map(g => ({
    t: g[0].t, open: g[0].open, close: g[g.length - 1].close,
    high: Math.max(...g.map(b => b.high)), low: Math.min(...g.map(b => b.low)),
    vol: g.reduce((s, b) => s + (b.vol || 0), 0),
  }));
}

const isoDay = t => new Date(t).toISOString().slice(0, 10);

async function getBars(spec, cache) {
  const once = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };
  if (spec.hype) {
    const hype = await once("HYPE", () => fetchDailyFrom("kucoin", "HYPEUSDT", 900));
    const bench = await once(spec.hype, () => fetchDailyPair(spec.hype, 900));
    return { source: `kucoin:HYPEUSDT/${bench.source}:${spec.hype}`, bars: synthTV(hype.bars, bench.bars) };
  }
  // Only Binance's real pair is trusted (it is what the TradingView charts use).
  // OKX/KuCoin cross pairs can be thin — OKX SOL-ETH returns bars that score 0
  // on VWMA indicators — so anywhere else, synthesize from liquid USDT pairs.
  try {
    const r = await once("binance:" + spec.pair, () => fetchDailyFrom("binance", spec.pair, 900));
    if (r.bars.length >= 250) return { source: `binance:${spec.pair}`, bars: r.bars };
  } catch (_) { /* Binance unreachable (e.g. US-hosted) -> synthesize */ }
  const base = spec.pair.slice(0, 3), quote = spec.pair.slice(3);
  const a = await once(base + "USDT", () => fetchDailyPair(base + "USDT", 900));
  const b = await once(quote + "USDT", () => fetchDailyPair(quote + "USDT", 900));
  return { source: `synth ${a.source}:${base}USDT/${b.source}:${quote}USDT`, bars: synthTV(a.bars, b.bars) };
}

function scoreBlock(rows, allBars) {
  const today = Math.floor(Date.now() / DAY);
  const closed = allBars.filter(b => Math.floor(b.t / DAY) < today);
  return rows.map(([indicator, key, tf, mode]) => {
    if (!key) return { indicator, tf, mode: null, score: null, live: null, since: null };
    const C = aggregateAnchored(closed, tf);
    const L = aggregateAnchored(allBars, tf);
    const s = IND[key](C), sl = IND[key](L);
    const score = s.length ? s[s.length - 1] : null;
    let k = s.length - 1;
    while (k > 0 && s[k - 1] === score) k--;
    return {
      indicator, tf, mode,
      score: Number.isFinite(score) ? score : null,
      live: sl.length && Number.isFinite(sl[sl.length - 1]) ? sl[sl.length - 1] : null,
      since: s.length ? isoDay(C[k].t) : null,
    };
  });
}

async function scoreRatioBlocks() {
  const cache = new Map();
  const blocks = {};
  for (const [name, spec] of Object.entries(BLOCKS)) {
    try {
      const { source, bars } = await getBars(spec, cache);
      if (bars.length < 250) throw new Error(`only ${bars.length} bars`);
      const today = Math.floor(Date.now() / DAY);
      const lastClosed = bars.filter(b => Math.floor(b.t / DAY) < today).pop();
      blocks[name] = { source, bars: bars.length, lastClosedBar: lastClosed ? isoDay(lastClosed.t) : null,
                       rows: scoreBlock(spec.rows, bars) };
    } catch (e) {
      blocks[name] = { error: e.message };
    }
  }
  return { asOf: new Date().toISOString(), blocks };
}

module.exports = { scoreRatioBlocks, synthTV, aggregateAnchored, BLOCKS };
