// ── Ratio TPI blocks for the RSPS "2 - Conservative Trend" tab ──
// Scores the six major-vs-major ratio TPIs (ETHBTC, SOLETH, SOLBTC, HYPEBTC,
// HYPEETH, HYPESOL) with each block's OWN indicator list and inputs, exactly as
// typed in the sheet. Apps Script (RATIO TPI AUTOFILL) writes the "auto" rows
// into the sheet's Score column and raises an alarm on everything else.
//
// Data, best first:
//   1. TradingView's own candles (keyless data socket) for BINANCE:<pair> — the
//      exact series the user's charts are drawn from, with full history.
//   2. Binance's real pair over REST.
//   3. A synthetic ratio from KuCoin USDT pairs (1500 days of history; OKX only
//      returns 300, too short for Pine 7's 159-period ATR on 3D bars).
//   Never a thin OKX/KuCoin cross pair: OKX SOL-ETH scored 0 on VWMA indicators.
//   HYPE*: KUCOIN:HYPEUSDT over the major's USDT pair, as the TradingView charts.
//
// Synthetic ratio bars are built component-wise, the way TradingView draws a
// spread chart (open/open, high/high, low/low, close/close). The older cross-bound
// form inflated the true range and broke every ATR-based indicator.
//
// Scores use the last CLOSED daily bar. `live` is the forming bar.

const { fetchDailyPair, fetchDailyFrom } = require("./fetch_ohlc");
const I = require("./indicators");
const RI = require("./ratio_indicators");

let fetchTV = null;
try { if (typeof WebSocket === "function") ({ fetchTV } = require("./tv_fetch")); } catch (_) { fetchTV = null; }

const DAY = 86400000, H4 = 4 * 3600000;

// Each indicator gets (chartBars, ctx) — ctx has the closed 1D and 4H bars for the
// multi-timeframe Pine 7.
const IND = {
  ekt42:   b => I.ekt(b, { atrBool: false, atrLen: 1, atrMult: 0.161, maLen: 42, maType: "SMA", srcKey: "close" }),
  ektVwma: b => I.ekt(b, { atrBool: true, atrLen: 20, atrMult: 1, maLen: 20, maType: "VWMA", srcKey: "close" }),
  medST:   b => I.medianST(b, { atrPeriod: 100, mul: 1.26, medianLen: 30, srcKey: "close" }),
  wrb40:   b => I.wrb(b, { len: 40, weighting: "Smooth", filterStrength: 0.11 }),
  wrb27:   b => I.wrb(b, { len: 27, weighting: "Smooth", filterStrength: 0.08, method: "ALMA" }),
  pMotion: b => I.pMotion(b, { emaLen: 20, sdLength: 30, multUp: 1.69, multDn: 1.45, srcKey: "close", demaLen: 3, prcLen: 3 }),
  khRsi:   b => I.kalmanHullRSI(b, { srcKey: "close", measNoise: 3, processNoise: 0.01, rsiPeriod: 12 }),
  rocWma:  b => I.rocWMA(b, { rocLen: 19, maLen: 10, sigLen: 9, srcKey: "close", neutralThr: 0.75, maType: "TEMA" }),
  stMaTma: b => I.stMA(b, { maType: "TMA", length: 100, atrPeriod: 44, atrMult: 1.51 }),
  // SOLETH
  pctST:   b => RI.pctST(b, { atrLen: 50, mult: 1.4178, slen: 30, srcKey: "high" }),
  demaHma: b => RI.demaHmaZ(b, { length: 100, smoothLen: 7, zLen: 7, srcKey: "close", longT: 0, shortT: 0 }),
  squeeze: b => RI.squeeze(b, { bbLen: 20, bbMult: 2, kcLen: 22, kcMult: 1.5 }),
  // SOLBTC
  emd:     b => RI.emdTrend(b, { srcKey: "close", avgType: "RMA", length: 20, mult: 1.5, neutralOpposite: true }),
  follow:  b => RI.followLine(b, { bbPeriod: 21, bbDev: 2, atrPeriod: 5, useAtr: false, atrMult: 2, pivotLen: 2, part: "pivot" }),
  dual:    b => RI.dualPhase(b, { lenLow: 60, lenHigh: 31, refit: 40, volPeriod: 17, volSmooth: 20, part: "agree" }),
  sgRsi:   b => RI.sgMedianRsi(b, { srcKey: "close", rsiPeriod: 7, medianLen: 35, longT: 176, shortT: 160 }),
  // Pine 7 ("Pina 5 Strategy"), per-block inputs; needs 1D + 4H context
  p7EthBtc: (b, x) => RI.pina5(b, 1, x.d1, x.h4, { maType: "HMA", maLen: 11, useSmooth: false, smoothLen: 10, useATR: true, atrLen: 159, atrMult: 0.7, lookback: 29 }),
  p7SolEth: (b, x) => RI.pina5(b, 2, x.d1, x.h4, { maType: "HMA", maLen: 9, useSmooth: false, useATR: false, atrLen: 1, atrMult: 0.7, lookback: 9 }),
  p7SolBtc: (b, x) => RI.pina5(b, 1, x.d1, x.h4, { maType: "SMA", maLen: 9, useSmooth: true, smoothLen: 5, useATR: false, atrLen: 9, atrMult: 0.7, lookback: 9 }),
};
// Strategy-based: the forming bar's colour is set by CLOSED bars only, so these
// run on complete chart bars and have no separate "live" value.
const CLOSED_ONLY = new Set(["p7EthBtc", "p7SolEth", "p7SolBtc"]);
const NEEDS_4H = new Set(["p7EthBtc", "p7SolEth", "p7SolBtc"]);

// Row names are the sheet's column-C text. mode:
//   auto  = ported with the sheet's inputs and validated -> written to the sheet
//   check = ported but not confirmed against the user's reading -> compared, never written
//   null  = not ported -> the sheet keeps the hand-typed value (staleness-alarmed)
const BLOCKS = {
  ETHBTC: { pair: "ETHBTC", rows: [
    ["Enhanced Keltner Trend",     "ekt42",    1, "auto"],
    ["Median Supertrend",          "medST",    1, "auto"],
    ["Weighted Regression Bands",  "wrb40",    1, "auto"],
    ["P-Motion Trend",             "pMotion",  1, "auto"],
    ["Pine 7",                     "p7EthBtc", 1, "auto"],
    ["Kalman Hull RSI",            "khRsi",    1, "auto"],
    ["ROC-Weighted MA Oscillator", "rocWma",   2, "auto"],
  ]},
  SOLETH: { pair: "SOLETH", rows: [
    ["25-75 ST",                   "pctST",    1, "auto"],
    ["Weighted Regression Bands",  "wrb27",    1, "auto"],
    ["EKT",                        "ektVwma",  2, "auto"],
    ["Pine 7",                     "p7SolEth", 2, "auto"],
    ["Dema HMA Oscillator",        "demaHma",  1, "auto"],
    ["Squeeze Momentum",           "squeeze",  2, "auto"],
  ]},
  SOLBTC: { pair: "SOLBTC", rows: [
    ["EMD Trend",                  "emd",      1, "auto"],
    ["ST MA",                      "stMaTma",  1, "auto"],
    ["Follow Line Trend Signal",   "follow",   2, "auto"],    // user reads the green/red pivot line only (confirmed Oct 15)
    ["Pine 7",                     "p7SolBtc", 1, "auto"],
    ["Dual-Phase Trend Regime",    "dual",     1, "auto"],    // user scores 0 when slow and fast oscillators disagree (Oct 15)
    ["Savitzky Golay Median Filtered RSI", "sgRsi", 1, "auto"],
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
// high/low re-bounded so the bar stays well-formed. Aligned on bar open time.
function synthTV(tok, bench, bucketMs = DAY) {
  const byT = new Map(bench.map(b => [Math.floor(b.t / bucketMs), b]));
  const out = [];
  for (const t of tok) {
    const b = byT.get(Math.floor(t.t / bucketMs));
    if (!b || !(b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0)) continue;
    const o = t.open / b.open, h = t.high / b.high, l = t.low / b.low, c = t.close / b.close;
    out.push({ t: t.t, open: o, high: Math.max(o, h, l, c), low: Math.min(o, h, l, c), close: c, vol: t.vol });
  }
  return out;
}

// n-day bars anchored to the Unix epoch, so grouping can't shift with history length.
// The trailing bucket may be partial (the forming bar, as of the last close).
function aggregateAnchored(bars, n, fullOnly = false) {
  if (n <= 1) return bars.slice();
  return RI.aggregateDays(bars, n, 0).filter(b => !fullOnly || b.full);
}

const isoDay = t => new Date(t).toISOString().slice(0, 10);

// KuCoin candles of any interval ("1day", "4hour"), up to 1500 per request.
async function kucoinCandles(pair, type, limit) {
  const sym = pair.replace(/(USDT|BTC|ETH)$/, "-$1");
  const step = type === "4hour" ? H4 / 1000 : DAY / 1000;
  const end = Math.floor(Date.now() / 1000), start = end - (Math.min(limit, 1500) + 2) * step;
  const r = await fetch(`https://api.kucoin.com/api/v1/market/candles?type=${type}&symbol=${sym}&startAt=${start}&endAt=${end}`);
  const j = await r.json();
  if (j.code !== "200000" || !Array.isArray(j.data)) throw new Error(`kucoin ${sym} ${type}: ${j.msg || j.code}`);
  return j.data.map(x => ({ t: +x[0] * 1000, open: +x[1], high: +x[3], low: +x[4], close: +x[2], vol: +x[5] })).reverse();
}

async function binanceKlines(pair, interval, limit) {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${Math.min(limit, 1000)}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`binance ${pair}: ${(j && j.msg) || "bad response"}`);
  return j.map(x => ({ t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], vol: +x[5] }));
}

async function tvBars(symbol, res, n) {
  if (!fetchTV) throw new Error("no WebSocket in this Node");
  const bars = await fetchTV(symbol, res, n, 25000);
  if (!bars || bars.length < 300) throw new Error(`TV ${symbol}: ${bars ? bars.length : 0} bars`);
  return bars;
}

// Returns { source, d1, h4? } for a block. h4 is fetched only when a row needs it.
async function getData(spec, need4h, cache) {
  const once = (key, fn) => { if (!cache.has(key)) cache.set(key, fn().catch(e => { cache.delete(key); throw e; })); return cache.get(key); };

  if (spec.hype) {
    const hype = await once("HYPE", async () => {
      try { return { src: "tv:KUCOIN:HYPEUSDT", bars: await tvBars("KUCOIN:HYPEUSDT", "1D", 2000) }; }
      catch (_) { return { src: "kucoin:HYPEUSDT", bars: (await fetchDailyFrom("kucoin", "HYPEUSDT", 900)).bars }; }
    });
    const bench = await once(spec.hype, async () => {
      try { return { src: `tv:BINANCE:${spec.hype}`, bars: await tvBars("BINANCE:" + spec.hype, "1D", 2000) }; }
      catch (_) { const r = await fetchDailyPair(spec.hype, 900); return { src: `${r.source}:${spec.hype}`, bars: r.bars }; }
    });
    return { source: `${hype.src} / ${bench.src}`, d1: synthTV(hype.bars, bench.bars) };
  }

  const pair = spec.pair, base = pair.slice(0, 3), quote = pair.slice(3);
  const tries = [
    async () => ({ source: `tv:BINANCE:${pair}`,
                   d1: await tvBars("BINANCE:" + pair, "1D", 4000),
                   h4: need4h ? await tvBars("BINANCE:" + pair, "240", 3000) : null }),
    async () => ({ source: `binance:${pair}`,
                   d1: await binanceKlines(pair, "1d", 1000),
                   h4: need4h ? await binanceKlines(pair, "4h", 1000) : null }),
    async () => {
      const [a, b] = await Promise.all([kucoinCandles(base + "USDT", "1day", 1500), kucoinCandles(quote + "USDT", "1day", 1500)]);
      let h4 = null;
      if (need4h) {
        const [a4, b4] = await Promise.all([kucoinCandles(base + "USDT", "4hour", 1500), kucoinCandles(quote + "USDT", "4hour", 1500)]);
        h4 = synthTV(a4, b4, H4);
      }
      return { source: `synth kucoin:${base}USDT/${quote}USDT`, d1: synthTV(a, b), h4 };
    },
  ];
  const errors = [];
  for (const t of tries) {
    try {
      const r = await t();
      if (r.d1.length >= 300 && (!need4h || (r.h4 && r.h4.length >= 400))) return r;
      errors.push(`${r.source}: too short`);
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(`no data for ${pair} (${errors.join("; ")})`);
}

function scoreBlock(rows, data) {
  const now = Date.now(), today = Math.floor(now / DAY);
  const closed = data.d1.filter(b => Math.floor(b.t / DAY) < today);
  const ctx = { d1: closed, h4: (data.h4 || []).filter(b => b.t + H4 <= now) };
  return rows.map(([indicator, key, tf, mode]) => {
    if (!key) return { indicator, tf, mode: null, score: null, live: null, since: null };
    const closedOnly = CLOSED_ONLY.has(key);
    const C = aggregateAnchored(closed, tf, closedOnly);
    const s = IND[key](C, ctx);
    const score = s.length ? s[s.length - 1] : null;
    let k = s.length - 1;
    while (k > 0 && s[k - 1] === score) k--;
    let live = null;
    if (!closedOnly) {
      const sl = IND[key](aggregateAnchored(data.d1, tf), ctx);
      live = sl.length && Number.isFinite(sl[sl.length - 1]) ? sl[sl.length - 1] : null;
    }
    return { indicator, tf, mode, score: Number.isFinite(score) ? score : null, live,
             since: s.length ? isoDay(C[k].t) : null };
  });
}

async function scoreRatioBlocks() {
  const cache = new Map();
  const blocks = {};
  for (const [name, spec] of Object.entries(BLOCKS)) {
    try {
      const need4h = spec.rows.some(r => NEEDS_4H.has(r[1]));
      const data = await getData(spec, need4h, cache);
      const today = Math.floor(Date.now() / DAY);
      const lastClosed = data.d1.filter(b => Math.floor(b.t / DAY) < today).pop();
      blocks[name] = { source: data.source, bars: data.d1.length, bars4h: data.h4 ? data.h4.length : undefined,
                       lastClosedBar: lastClosed ? isoDay(lastClosed.t) : null, rows: scoreBlock(spec.rows, data) };
    } catch (e) {
      blocks[name] = { error: e.message };
    }
  }
  return { asOf: new Date().toISOString(), blocks };
}

module.exports = { scoreRatioBlocks, synthTV, aggregateAnchored, BLOCKS, IND };
