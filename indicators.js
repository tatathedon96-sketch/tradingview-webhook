// ── Ported TradingView indicators ──
// Each returns a per-bar signal series of +1 (bullish) / -1 (bearish) / 0 (neutral),
// computed from the script's OWN native trend/color state (per user: "just go with that").
// Only indicators whose full Pine source is confirmed are implemented here.

const P = require("./pine");
const { mapHtfToDaily } = require("./fetch_ohlc");

// SuperTrended Moving Averages ("ST MA") — full source provided by user.
// Signal = the script's `trend` variable (+1 up / -1 down).
// Inputs from screenshot SOLBTC: src=close, maType=TMA, len=100, atrPeriod=44, atrMult=1.51.
function stMA(bars, { maType = "EMA", length = 100, atrPeriod = 10, atrMult = 0.5, changeATR = true } = {}) {
  const close = bars.map(b => b.close);
  const MA = P.ma(maType, close, length, bars.map(b => b.vol));
  const atr = changeATR ? P.atr(bars, atrPeriod) : P.sma(P.trueRange(bars), atrPeriod);

  const up = new Array(bars.length).fill(P.NA);
  const dn = new Array(bars.length).fill(P.NA);
  const trend = new Array(bars.length).fill(P.NA);

  for (let i = 0; i < bars.length; i++) {
    if (P.isNa(MA[i]) || P.isNa(atr[i])) continue;
    let rawUp = MA[i] - atrMult * atr[i];
    let rawDn = MA[i] + atrMult * atr[i];
    const up1 = P.nz(up[i - 1], rawUp);
    const dn1 = P.nz(dn[i - 1], rawDn);
    up[i] = bars[i - 1] && bars[i - 1].close > up1 ? Math.max(rawUp, up1) : rawUp;
    dn[i] = bars[i - 1] && bars[i - 1].close < dn1 ? Math.min(rawDn, dn1) : rawDn;

    const prevTrend = P.nz(trend[i - 1], 1);
    let t = prevTrend;
    if (prevTrend === -1 && bars[i].close > dn1) t = 1;
    else if (prevTrend === 1 && bars[i].close < up1) t = -1;
    trend[i] = t;
  }
  return trend.map(t => (P.isNa(t) ? 0 : t));
}

// Pine 7 = "Pina 5 / P5 Strategy" — full source provided by user.
// Stateful long/flat position; signal = +1 while holding long, -1 while flat.
// Uses 3D bands + chart-TF ema21 + 4h ema200. Caller passes the resolved series.
// `avgLine3D` and `ema200_4h` must already be mapped onto the chart-TF bars.
function pine7({ close, ema21, avgLine3D, ema200_4h }) {
  const n = close.length;
  const sig = new Array(n).fill(0);
  let pos = 0; // 0 flat, 1 long
  for (let i = 0; i < n; i++) {
    const ready = [close[i], ema21[i], avgLine3D[i], ema200_4h[i]].every(x => Number.isFinite(x));
    if (ready) {
      const longCond = close[i] > avgLine3D[i] && ema21[i] > avgLine3D[i] && close[i] > ema200_4h[i];
      const sellCond = close[i] < avgLine3D[i] && ema21[i] < avgLine3D[i] && close[i] < ema200_4h[i];
      if (longCond) pos = 1;
      else if (sellCond && pos > 0) pos = 0;
    }
    sig[i] = pos > 0 ? 1 : -1;
  }
  return sig;
}

// Enhanced Keltner Trend ("EKT") — full source pulled from TradingView.
// trend = barssince(bull) <= barssince(bear) ? blue(bull) : orange(bear)
// where bull = src > upperBand[1], bear = src < lowerBand[1].
// ETHBTC inputs: atrBool=OFF, atrLen=1, atrMult=0.161, maLen=42, src=close, maType=SMA.
function ekt(bars, { atrBool = true, atrLen = 9, atrMult = 0.7, maLen = 11, maType = "EMA", srcKey = "close" } = {}) {
  const src = bars.map(b => b[srcKey]);
  const high = bars.map(b => b.high), low = bars.map(b => b.low);
  const vol = bars.map(b => b.vol);

  const highLowRange = P.highest(high, maLen).map((h, i) => {
    const l = P.lowest(low, maLen)[i]; return (P.isNa(h) || P.isNa(l)) ? P.NA : h - l;
  });
  const priceBasis = P.ma(maType, src, maLen, vol);
  const channelWidth = atrBool ? P.atr(bars, atrLen) : highLowRange;
  const movBase = P.ma(maType, channelWidth, maLen, vol);
  const movFactor = movBase.map(x => (P.isNa(x) ? P.NA : x * atrMult));
  const upper = priceBasis.map((p, i) => (P.isNa(p) || P.isNa(movFactor[i]) ? P.NA : p + movFactor[i]));
  const lower = priceBasis.map((p, i) => (P.isNa(p) || P.isNa(movFactor[i]) ? P.NA : p - movFactor[i]));

  const bull = src.map((s, i) => i > 0 && !P.isNa(upper[i - 1]) && s > upper[i - 1]);
  const bear = src.map((s, i) => i > 0 && !P.isNa(lower[i - 1]) && s < lower[i - 1]);
  const bsBull = P.barssince(bull.map((b, i) => b && !bear[i]));
  const bsBear = P.barssince(bear.map((b, i) => b && !bull[i]));

  return src.map((_, i) => {
    const a = bsBull[i], b = bsBear[i];
    if (P.isNa(a) && P.isNa(b)) return 0;
    const isBull = !P.isNa(a) && !P.isNa(b) && a <= b; // Pine: na comparison -> false -> bear
    return isBull ? 1 : -1;
  });
}

// Median Supertrend (viResearch) — standard supertrend on a median-smoothed source.
// direction d: d<0 = uptrend/bull, d>0 = downtrend/bear (Pine ta.supertrend convention).
// ETHBTC inputs: atrPeriod(subject)=100, mul=1.26, medianLen(slen)=30, src=close.
function medianST(bars, { atrPeriod = 10, mul = 2.15, medianLen = 14, srcKey = "close" } = {}) {
  const close = bars.map(b => b.close);
  const smooth = P.percentileNearestRank(bars.map(b => b[srcKey]), medianLen, 50);
  const atr = P.atr(bars, atrPeriod);
  const n = bars.length;
  const u = new Array(n).fill(P.NA), l = new Array(n).fill(P.NA);
  const d = new Array(n).fill(P.NA), st = new Array(n).fill(P.NA);

  for (let i = 0; i < n; i++) {
    if (P.isNa(smooth[i]) || P.isNa(atr[i])) continue;
    let ui = smooth[i] + mul * atr[i];
    let li = smooth[i] - mul * atr[i];
    const pl = P.nz(l[i - 1]), pu = P.nz(u[i - 1]);
    li = (li > pl || (i > 0 && close[i - 1] < pl)) ? li : pl;
    ui = (ui < pu || (i > 0 && close[i - 1] > pu)) ? ui : pu;
    l[i] = li; u[i] = ui;

    const pt = st[i - 1];
    let di;
    if (i === 0 || P.isNa(atr[i - 1])) di = 1;
    else if (pt === pu) di = close[i] > ui ? -1 : 1;
    else di = close[i] < li ? 1 : -1;
    d[i] = di;
    st[i] = di === -1 ? li : ui;
  }
  return d.map(x => (P.isNa(x) ? 0 : x < 0 ? 1 : -1));
}

// P-Motion Trend (QuantEdgeB) — full source. Persistent state QB.
// DEMA(close,dema_len) -> median(prc_len) -> EMA(ema_len); ±SD bands.
// QB := +1 if close>LongE (and not below ShortE); -1 if close<ShortE. Signal = QB.
// ETHBTC inputs "20,1.69,1.45,CLOSE,3,3": ema_len=20, mult_up=1.69, mult_dn=1.45,
// src=close, dema_len=3, prc_len=3 (SD_length left at default 30 — CONFIRM with user).
function pMotion(bars, { emaLen = 21, sdLength = 30, multUp = 1.5, multDn = 1.5, srcKey = "close", demaLen = 7, prcLen = 2 } = {}) {
  const close = bars.map(b => b.close);
  const src = bars.map(b => b[srcKey]);
  const dema = P.ma("DEMA", src, demaLen);
  const prcSmooth = P.percentileNearestRank(dema, prcLen, 50);
  const filterSD = P.stdev(dema, sdLength);
  const emaLine = P.ema(prcSmooth, emaLen);

  const n = bars.length;
  const sig = new Array(n).fill(0);
  let QB = 0;
  for (let i = 0; i < n; i++) {
    if ([emaLine[i], filterSD[i]].every(x => Number.isFinite(x))) {
      const longE = emaLine[i] + filterSD[i] * multUp;
      const shortE = emaLine[i] - filterSD[i] * multDn;
      const longC = close[i] > longE, shortC = close[i] < shortE;
      if (longC && !shortC) QB = 1;
      if (shortC) QB = -1;
    }
    sig[i] = QB > 0 ? 1 : QB < 0 ? -1 : 0;
  }
  return sig;
}

// ROC-Weighted MA Oscillator (SeerQuant) — full source. Native color state holds
// through the neutral zone: bull if osc>thr, bear if osc<-thr, else keep previous.
// ETHBTC inputs "19,10,9,CLOSE,0.75,TEMA": rocLen=19, maLen=10, sigLen=9, src=close,
// neutralThr=0.75, maType=TEMA.
function rocWMA(bars, { rocLen = 55, maLen = 7, sigLen = 9, srcKey = "close", neutralThr = 0.5, maType = "TEMA" } = {}) {
  const src = bars.map(b => b[srcKey]);
  const rocSer = P.roc(src, rocLen);
  const hi = P.highest(rocSer, rocLen), lo = P.lowest(rocSer, rocLen);
  const normRoc = rocSer.map((r, i) => {
    if ([r, hi[i], lo[i]].some(x => P.isNa(x)) || hi[i] === lo[i]) return P.NA;
    return (r - lo[i]) / (hi[i] - lo[i]);
  });
  const baseMA = P.ma(maType, src, maLen, bars.map(b => b.vol));
  const rwma = src.map((s, i) => (P.isNa(normRoc[i]) || P.isNa(baseMA[i]) ? P.NA : baseMA[i] + normRoc[i] * (s - baseMA[i])));
  // zscore(rwma, rocLen)
  const mean = P.sma(rwma, rocLen), sd = P.stdev(rwma, rocLen);
  const osc = rwma.map((v, i) => (P.isNa(v) || P.isNa(mean[i]) || P.isNa(sd[i]) || sd[i] === 0 ? P.NA : (v - mean[i]) / sd[i]));

  const n = bars.length;
  const sig = new Array(n).fill(0);
  let col = 0; // 0 none, 1 bull, -1 bear (persists through neutral zone)
  for (let i = 0; i < n; i++) {
    if (!P.isNa(osc[i])) {
      const inNeutral = osc[i] > -neutralThr && osc[i] < neutralThr;
      if (!inNeutral) col = osc[i] > neutralThr ? 1 : osc[i] < -neutralThr ? -1 : col;
    }
    sig[i] = col;
  }
  return sig;
}

// Kalman Hull RSI (BackQuant) — full source. The 5-state Kalman arrays stay
// element-identical (same init + same per-element update), so it reduces to a
// scalar filter. Per bar the script calls f_kalman 4x in this order (shared state):
//   1) f_kalman(src, R=measNoise)           [standalone kalmanFilteredPrice]
//   2) a = f_kalman(src, R=measNoise/2)     [inside KHMA]
//   3) b = f_kalman(src, R=measNoise)
//   4) KHMA = f_kalman(2a-b, R=round(sqrt(measNoise)))
// Then kalman_hull_rsi = rsi(KHMA, rsiPeriod); bull if >50, bear if <50.
// ETHBTC inputs "Close,3,0.01,12": measNoise=3, processNoise=0.01, rsiPeriod=12.
function kalmanHullRSI(bars, { srcKey = "close", measNoise = 3.0, processNoise = 0.01, rsiPeriod = 12 } = {}) {
  const src = bars.map(b => b[srcKey]);
  const n = bars.length;
  let x = NaN, Pcov = NaN; // scalar Kalman state, persists across bars
  const step = (s, R) => {
    const predX = x, predP = Pcov + processNoise;
    const kg = predP / (predP + R);
    x = predX + kg * (s - predX);
    Pcov = (1 - kg) * predP;
    return x;
  };
  const khma = new Array(n).fill(NaN);
  const R2 = Math.round(Math.sqrt(measNoise));
  for (let i = 0; i < n; i++) {
    const s = src[i];
    if (!Number.isFinite(s)) continue;
    if (!Number.isFinite(x)) { x = s; Pcov = 1.0; } // f_init on first valid bar
    step(s, measNoise);            // call 1 (unused output)
    const a = step(s, measNoise / 2); // call 2
    const b = step(s, measNoise);     // call 3
    khma[i] = step(2 * a - b, R2);    // call 4
  }
  const khrsi = P.rsi(khma, rsiPeriod);
  return khrsi.map(v => (P.isNa(v) ? 0 : v > 50 ? 1 : v < 50 ? -1 : 0));
}

// Weighted Regression Bands (Zeiierman) — full source. Trend = sign of the
// fairvalue slope (bull if rising), holding on flat. The script's "Linear
// Regression" method is a no-op (loop uses y=whlMid, not whlMid[i]), so
// fairvalue == whlMid = kf-smoothed weighted-median line. Bands/mult don't
// affect the trend and are ignored for scoring.
// ETHBTC inputs "40,0.5,LINEAR REGRESSION,SMOOTH,0.11":
//   len=40, method=Linear Regression, weighting=Smooth, filterStrength=0.11.
function wrb(bars, { len = 50, weighting = "Smooth", filterStrength = 0.08, method = "Linear Regression" } = {}) {
  const high = bars.map(b => b.high), low = bars.map(b => b.low);
  const n = bars.length;

  // Smooth weighted mid: weighted mean of bar medians, weight = range * (1-k/len)^2.
  // (For "Smooth", the Highest and Lowest formulas are identical, so mid == that mean.)
  const smoothMid = new Array(n).fill(P.NA);
  for (let i = len - 1; i < n; i++) {
    let num = 0, denom = 0, ok = true;
    for (let k = 0; k < len; k++) {
      const hh = high[i - k], ll = low[i - k];
      if (!Number.isFinite(hh) || !Number.isFinite(ll)) { ok = false; break; }
      const med = (hh + ll) / 2, rng = hh - ll, decay = Math.pow(1 - k / len, 2);
      const w = rng * decay; num += med * w; denom += w;
    }
    if (ok && denom !== 0) smoothMid[i] = num / denom;
  }

  // kf smoother: kf := kf[1] + alpha*(src - kf[1]), seeded with first src.
  const fair = new Array(n).fill(P.NA);
  let kf = NaN;
  for (let i = 0; i < n; i++) {
    const s = smoothMid[i];
    if (!Number.isFinite(s)) continue;
    kf = Number.isFinite(kf) ? kf + filterStrength * (s - kf) : s;
    fair[i] = kf; // fairvalue == whlMid (LinReg method is a no-op)
  }

  const sig = new Array(n).fill(0);
  let col = 0;
  for (let i = 1; i < n; i++) {
    if (Number.isFinite(fair[i]) && Number.isFinite(fair[i - 1])) {
      const slope = fair[i] - fair[i - 1];
      col = slope > 0 ? 1 : slope < 0 ? -1 : col;
    }
    sig[i] = col;
  }
  return sig;
}

// Pine 7 resolver — builds the 3D avgLine, chart-TF ema21, and 4H ema200 from the
// three bar resolutions, maps HTF series onto the daily timeline (request.security,
// lookahead_off flavor), then runs the stateful pine7 long/flat logic.
// NOTE: the original is a repainting multi-TF strategy; the current-bar state is
// what the live chart shows, but historical entries/exits are approximate.
function pine7Resolved(bars1d, bars3d, bars4h, opts = {}) {
  const { maType = "EMA", maLen = 11, useSmooth = true, smoothLen = 5,
    useATR = true, atrLen = 9, atrMult = 0.7, lookback = 19 } = opts;

  // 3D bands
  const close3 = bars3d.map(b => b.close);
  const atr3 = P.atr(bars3d, atrLen);
  const upSrc = useATR ? close3.map((c, i) => (P.isNa(atr3[i]) ? P.NA : c + atr3[i] * atrMult)) : bars3d.map(b => b.high);
  const loSrc = useATR ? close3.map((c, i) => (P.isNa(atr3[i]) ? P.NA : c - atr3[i] * atrMult)) : bars3d.map(b => b.low);
  const upper3D = P.highest(upSrc, lookback);
  const lower3D = P.lowest(loSrc, lookback);
  const avgBase = upper3D.map((u, i) => (P.isNa(u) || P.isNa(lower3D[i]) ? P.NA : (u + lower3D[i]) / 2));
  const avgMA = P.ma(maType, avgBase, maLen);
  const avgLine3Dseries = useSmooth ? P.sma(avgMA, smoothLen) : avgMA;

  const avgLine3D = mapHtfToDaily(bars1d, bars3d, avgLine3Dseries);
  const ema21 = P.ema(bars1d.map(b => b.close), 21);
  const ema200_4h = mapHtfToDaily(bars1d, bars4h, P.ema(bars4h.map(b => b.close), 200));

  return pine7({ close: bars1d.map(b => b.close), ema21, avgLine3D, ema200_4h });
}

module.exports = { stMA, pine7, pine7Resolved, ekt, medianST, pMotion, rocWMA, kalmanHullRSI, wrb };
