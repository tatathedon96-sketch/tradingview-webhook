// ── Ports for the SOLETH / SOLBTC / ETHBTC-only ratio TPI indicators ──
// Each is ported line-by-line from the script's published Pine source (fetched
// from pine-facade, Oct 15 2026) and returns a per-bar signal from the script's
// OWN state variable: +1 bullish / -1 bearish / 0 neutral or not-yet-defined.
//
//   pctST        25-75 Percentile SuperTrend | Mattes            (state `Mattes`)
//   demaHmaZ     DEMA HMA Z-score Oscillator (EarthlyExile)        (state `trend`)
//   squeeze      Squeeze Momentum Indicator [LazyBear]             (sign of `val`)
//   emdTrend     EMD Trend [InvestorUnknown]                       (state `direction`)
//   followLine   Follow Line Trend Signal (Ankit_1618)             (`_t_signal`)
//   dualPhase    Dual-Phase Trend Regime Oscillator (Zeiierman)    (`trend_regime`)
//   sgMedianRsi  Savitzky Golay Median Filtered RSI [BackQuant]    (`BackQuant`)
//   pina5        Pina 5 Strategy ("Pine 7", the user's own)        (long = +1, flat = -1)

const P = require("./pine");
const NA = NaN, fin = Number.isFinite;
const DAY = 86400000;

const col = (bars, k) => bars.map(b => b[k]);

// ── 25-75 Percentile SuperTrend ──
// inputs: subject (ATR length), mult, slen (percentile length), src (default high)
function pctST(bars, { atrLen = 14, mult = 1, slen = 27, srcKey = "high" } = {}) {
  const n = bars.length, close = col(bars, "close");
  const src = col(bars, srcKey);
  const lo = P.percentileNearestRank(src, slen, 25);
  const hi = P.percentileNearestRank(src, slen, 75);
  const atr = P.atr(bars, atrLen);
  const upperS = new Array(n).fill(NA), lowerS = new Array(n).fill(NA), st = new Array(n).fill(NA);
  const dist = new Array(n).fill(NA);
  const out = new Array(n).fill(0);
  let mattes = 0;
  for (let i = 0; i < n; i++) {
    let upper = hi[i] + mult * atr[i];
    let lower = lo[i] - mult * atr[i];
    const pl = i > 0 ? P.nz(lowerS[i - 1]) : 0;
    const pu = i > 0 ? P.nz(upperS[i - 1]) : 0;
    const c1 = i > 0 ? close[i - 1] : NA;
    lower = (lower > pl || c1 < pl) ? lower : pl;      // na comparisons are false in Pine
    upper = (upper < pu || c1 > pu) ? upper : pu;
    lowerS[i] = lower; upperS[i] = upper;
    const pt = i > 0 ? st[i - 1] : NA;
    let d;
    if (i === 0 || !fin(atr[i - 1])) d = 1;
    else if (pt === pu) d = close[i] > upper ? -1 : 1;
    else d = close[i] < lower ? 1 : -1;
    dist[i] = d;
    st[i] = d === -1 ? lower : upper;
    if (i > 0) {
      const crossUnder = dist[i] < 0 && dist[i - 1] >= 0;   // ta.crossunder(dist, 0)
      const crossOver = dist[i] > 0 && dist[i - 1] <= 0;    // ta.crossover(dist, 0)
      if (crossUnder && !crossOver) mattes = 1;
      if (crossOver) mattes = -1;
    }
    out[i] = mattes;
  }
  return out;
}

// ── DEMA HMA Z-score Oscillator ──
function demaHmaZ(bars, { length = 85, smoothLen = 7, zLen = 7, srcKey = "close", longT = 0, shortT = 0 } = {}) {
  const src = col(bars, srcKey);
  const w1 = P.wma(src, Math.floor(length / 2)), w2 = P.wma(src, length);
  const diff = src.map((_, i) => (fin(w1[i]) && fin(w2[i]) ? 2 * w1[i] - w2[i] : NA));
  const hma = P.wmaSafe(diff, Math.floor(Math.sqrt(length)));
  const smoothed = P.ma("DEMA", hma, smoothLen);
  const avg = P.sma(smoothed, zLen), sd = P.stdev(smoothed, zLen);
  const out = new Array(bars.length).fill(0);
  let trend = 0;
  for (let i = 0; i < bars.length; i++) {
    const z = fin(smoothed[i]) && fin(avg[i]) && fin(sd[i]) && sd[i] !== 0 ? (smoothed[i] - avg[i]) / sd[i] : NA;
    const L = z > longT, S = z < shortT;                  // false when z is na
    if (L && !S) trend = 1;
    if (S) trend = -1;
    out[i] = trend;
  }
  return out;
}

// ── Squeeze Momentum [LazyBear] ──  signal = sign of the momentum histogram `val`.
// (The script's BB uses the KC multiplier — a LazyBear quirk that only affects the
// squeeze dots, not `val`.)
function squeeze(bars, { bbLen = 20, bbMult = 2, kcLen = 20, kcMult = 1.5 } = {}) {
  const close = col(bars, "close");
  const hh = P.highest(col(bars, "high"), kcLen), ll = P.lowest(col(bars, "low"), kcLen);
  const sm = P.sma(close, kcLen);
  const x = close.map((c, i) => (fin(hh[i]) && fin(ll[i]) && fin(sm[i]) ? c - ((hh[i] + ll[i]) / 2 + sm[i]) / 2 : NA));
  const val = P.linreg(x, kcLen, 0);
  return val.map(v => (fin(v) ? (v > 0 ? 1 : v < 0 ? -1 : 0) : 0));
}

// ── EMD Trend [InvestorUnknown] ──
// neutralOpposite: the user's scoring rule (same as the MTPI's Keltner / Q KAMA) —
// 0 while price sits on the wrong side of the average for the line's colour.
function emdTrend(bars, { srcKey = "close", avgType = "SMA", length = 28, mult = 1, neutralOpposite = false } = {}) {
  const src = col(bars, srcKey);
  const avg = P.ma(avgType, src, length);
  const absDev = src.map((s, i) => (fin(avg[i]) ? Math.abs(s - avg[i]) : NA));
  const emd = P.ema(absDev, length);
  const up = avg.map((a, i) => (fin(a) && fin(emd[i]) ? a + emd[i] * mult : NA));
  const dn = avg.map((a, i) => (fin(a) && fin(emd[i]) ? a - emd[i] * mult : NA));
  const out = new Array(bars.length).fill(0);
  let dir = 0;
  for (let i = 0; i < bars.length; i++) {
    if (P.crossover(src, up, i)) dir = 1;
    else if (P.crossunder(src, dn, i)) dir = -1;
    const opposite = (dir > 0 && src[i] < avg[i]) || (dir < 0 && src[i] > avg[i]);
    out[i] = neutralOpposite && opposite ? 0 : dir;
  }
  return out;
}

// Pine ta.pivothigh/pivotlow(left, right): value at bar i-right, reported on bar i.
function pivot(src, left, right, isHigh) {
  const out = new Array(src.length).fill(NA);
  for (let i = left + right; i < src.length; i++) {
    const c = i - right, v = src[c];
    if (!fin(v)) continue;
    let ok = true;
    for (let k = c - left; k <= c + right && ok; k++) {
      if (k === c) continue;
      const w = src[k];
      if (!fin(w)) { ok = false; break; }
      if (isHigh ? (k < c ? w >= v : w > v) : (k < c ? w <= v : w < v)) ok = false;
    }
    if (ok) out[i] = v;
  }
  return out;
}

// ── Follow Line Trend Signal (Ankit_1618) ──  signal = `_t_signal`: both the
// Follow Line and the pivot trend agree (+1 / -1), else 0.
function followLine(bars, { bbPeriod = 21, bbDev = 2, atrPeriod = 14, useAtr = true, atrMult = 3, pivotLen = 5, part = "signal" } = {}) {
  const n = bars.length, close = col(bars, "close"), high = col(bars, "high"), low = col(bars, "low");
  const sm = P.sma(close, bbPeriod), sd = P.stdev(close, bbPeriod);
  const atr = P.atr(bars, atrPeriod);
  const ph = pivot(high, pivotLen, pivotLen, true), pl = pivot(low, pivotLen, pivotLen, false);
  const out = new Array(n).fill(0);
  let bbSignal = 0, trendLine = 0, prevTL = 0, iTrend = 0;
  let median = NA, tUp = NA, tDn = NA, prevTUp = NA, prevTDn = NA, Trend = 0, prevTrend = NA;
  let prevSig = 0;
  for (let i = 0; i < n; i++) {
    const bbU = sm[i] + sd[i] * bbDev, bbL = sm[i] - sd[i] * bbDev;
    if (close[i] > bbU) bbSignal = 1;
    if (close[i] < bbL) bbSignal = -1;
    let tl = trendLine;
    if (bbSignal > 0) {
      tl = useAtr ? low[i] - atr[i] : low[i];
      if (tl < prevTL) tl = prevTL;
    }
    if (bbSignal < 0) {
      tl = useAtr ? high[i] + atr[i] : high[i];
      if (tl > prevTL) tl = prevTL;
    }
    // Pine: an na TrendLine (ATR still warming up) stays na; comparisons with na are false
    trendLine = tl;
    if (trendLine > prevTL) iTrend = 1;
    if (trendLine < prevTL) iTrend = -1;
    const tColorBlue = iTrend > 0;

    const lastPivot = fin(ph[i]) && ph[i] !== 0 ? ph[i] : fin(pl[i]) && pl[i] !== 0 ? pl[i] : NA;
    if (fin(lastPivot)) median = fin(median) ? (median * 2 + lastPivot) / 3 : lastPivot;
    const upperPiv = median - atrMult * atr[i];
    const lowerPiv = median + atrMult * atr[i];
    const c1 = i > 0 ? close[i - 1] : NA;
    tUp = c1 > prevTUp ? Math.max(upperPiv, prevTUp) : upperPiv;
    tDn = c1 < prevTDn ? Math.min(lowerPiv, prevTDn) : lowerPiv;
    Trend = close[i] > prevTDn ? 1 : close[i] < prevTUp ? -1 : (fin(prevTrend) ? prevTrend : 1);
    const lime = Trend === 1 && P.nz(prevTrend) === 1;
    const red = Trend === -1 && P.nz(prevTrend) === -1;
    const sig = lime && tColorBlue ? 1 : red && !tColorBlue ? -1 : 0;
    // part: "signal" = the script's _t_signal (both lines agree); "line" = the Follow
    // Line's own colour (blue +1 / red -1); "pivot" = the pivot trend line alone.
    out[i] = part === "line" ? (tColorBlue ? 1 : -1) : part === "pivot" ? Trend : sig;
    prevSig = sig;
    prevTL = trendLine; prevTUp = tUp; prevTDn = tDn; prevTrend = Trend;
  }
  return out;
}

// Pearson correlation of src with bar_index over `len` bars (ta.correlation).
function corrWithIndex(src, len) {
  const out = new Array(src.length).fill(NA);
  for (let i = len - 1; i < src.length; i++) {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, ok = true;
    for (let k = 0; k < len; k++) {
      const x = i - k, y = src[i - k];
      if (!fin(y)) { ok = false; break; }
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    if (!ok) continue;
    const cov = sxy / len - (sx / len) * (sy / len);
    const vx = sxx / len - (sx / len) ** 2, vy = syy / len - (sy / len) ** 2;
    if (vx > 0 && vy > 0) out[i] = cov / Math.sqrt(vx * vy);
  }
  return out;
}

const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ── Dual-Phase Trend Regime Oscillator (Zeiierman) ──
// NOTE: the volatility "refit" runs every `refit` bars counted from the start of the
// chart's history, so values depend slightly on how much history the source has.
function dualPhase(bars, { lenLow = 36, lenHigh = 18, refit = 50, volPeriod = 20, volSmooth = 5 } = {}) {
  const n = bars.length, close = col(bars, "close");
  const ret = close.map((c, i) => (i > 0 ? c / close[i - 1] - 1 : NA));
  const volRaw = P.stdev(ret, volPeriod);
  const volSm = P.sma(volRaw, volSmooth);
  const oLow = corrWithIndex(close, lenLow).map(r => (fin(r) ? (r + 1) / 2 : NA));
  const oHigh = corrWithIndex(close, lenHigh).map(r => (fin(r) ? (r + 1) / 2 : NA));
  const vola = [];
  let lastRefit = 0, c1 = NA, c2 = NA, prevC1 = NA;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (fin(volRaw[i])) vola.push(volRaw[i]);
    if (vola.length > 150) vola.shift();
    const c1Prev = prevC1;                       // cluster_1[1]
    if (vola.length >= 150 && (i - lastRefit >= refit || !fin(c1Prev))) {
      const med = median(vola);
      let sl = 0, nl = 0, sh = 0, nh = 0;
      for (const el of vola) { if (el < med) { sl += el; nl++; } else { sh += el; nh++; } }
      const lowC = nl ? sl / nl : NA, highC = nh ? sh / nh : NA;
      if (fin(lowC) && fin(highC)) {
        c1 = !fin(c1) ? lowC : c1 + 0.1 * (lowC - c1);
        c2 = !fin(c2) ? highC : c2 + 0.1 * (highC - c2);
        lastRefit = i;
      }
      if (fin(c1) && fin(c2) && c1 > c2) { const t = c1; c1 = c2; c2 = t; }
    }
    prevC1 = c1;
    let regime = NA;
    if (fin(volSm[i]) && fin(c1) && fin(c2)) regime = volSm[i] < (c1 + c2) / 2 ? 0 : 1;
    const osc = fin(regime) ? (regime === 1 ? oHigh[i] : oLow[i]) : NA;
    out[i] = fin(osc) ? (osc > 0.5 ? 1 : osc < 0.5 ? -1 : 0) : 0;
  }
  return out;
}

// ── Savitzky Golay Median Filtered RSI [BackQuant] ──
// The script's SG "inverse" is a 2x2 shortcut, not a true least-squares solve, so
// its coefficients do not sum to 1 — which is why its thresholds sit near 160-180.
// Reproduced exactly as written.
function sgCoeffs(win, deg) {
  const hw = Math.floor((win - 1) / 2);
  const m = new Array(win * (deg + 1)).fill(0), inv = new Array(win * win).fill(0), c = new Array(win).fill(0);
  for (let i = 0; i < win; i++) for (let j = 0; j <= deg; j++) m[i * (deg + 1) + j] = Math.pow(i - hw, j);
  for (let i = 0; i < win; i++) for (let j = 0; j < win; j++) {
    let acc = 0;
    for (let k = 0; k <= deg; k++) acc += m[j * (deg + 1) + k] * m[i * (deg + 1) + k];
    inv[i * win + j] = acc;
  }
  const a = inv[0], b = inv[1], cc = inv[2], d = inv[3], det = a * d - b * cc;
  const iv = [d / det, -b / det, -cc / det, a / det];
  for (let i = 0; i < win; i++) {
    let t = 0;
    for (let j = 0; j < win; j++) t += (j < 3 ? iv[j] : iv[3]) * m[i * (deg + 1)];
    c[i] = t;
  }
  return c;
}

function sgMedianRsi(bars, { srcKey = "ohlc4", rsiPeriod = 14, medianLen = 7, longT = 176, shortT = 162 } = {}) {
  const src = srcKey === "ohlc4" ? bars.map(b => (b.open + b.high + b.low + b.close) / 4) : col(bars, srcKey);
  const r = P.rsi(src, rsiPeriod);
  const k = sgCoeffs(5, 2);
  // filtered += coeff[i] * src[i]  (src[i] = i bars ago)
  const sg = r.map((_, i) => {
    if (i < 4) return NA;
    let s = 0;
    for (let j = 0; j < 5; j++) { const v = r[i - j]; if (!fin(v)) return NA; s += k[j] * v; }
    return s;
  });
  const med = P.percentileNearestRank(sg, medianLen, 50);   // odd length: same as ta.median
  return med.map(m => {
    if (!fin(m)) return 0;
    const L = m >= longT, S = m < shortT;
    return S ? -1 : L ? 1 : 0;
  });
}

// ── Pina 5 Strategy ("Pine 7") ──
// Ported from the source the user pasted. The 3D midline comes from completed 3D
// bars (request.security, lookahead off, as TradingView replays history); the MA
// and smoothing then run on the CHART timeframe. The strategy fills on the next
// bar's open, so the colour of the bar now forming = position after the last
// closed bar — which is what the returned last value is.
//   chartBars: closed bars at the chart timeframe (1D or 2D)
//   bars1d:    closed daily bars (to build 3D), bars4h: closed 4H bars
const hmaPine = (src, len) => {
  const w1 = P.wma(src, Math.floor(len / 2)), w2 = P.wma(src, len);
  const diff = src.map((_, i) => (fin(w1[i]) && fin(w2[i]) ? 2 * w1[i] - w2[i] : NA));
  return P.wmaSafe(diff, Math.round(Math.sqrt(len)));
};
function maPine(type, src, len, vol) {
  return String(type).toUpperCase() === "HMA" ? hmaPine(src, len) : P.ma(type, src, len, vol);
}

function aggregateDays(bars1d, n, phase = 0) {
  const g = new Map();
  for (const b of bars1d) {
    const k = Math.floor((Math.floor(b.t / DAY) - phase) / n);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(b);
  }
  return [...g.entries()].sort((a, b) => a[0] - b[0]).map(([k, x]) => ({
    t: (k * n + phase) * DAY, closeT: (k * n + phase + n) * DAY, full: x.length === n,
    open: x[0].open, close: x[x.length - 1].close,
    high: Math.max(...x.map(b => b.high)), low: Math.min(...x.map(b => b.low)),
    vol: x.reduce((s, b) => s + (b.vol || 0), 0),
  }));
}

// value of the last HTF bar whose close is at or before each chart bar's close
function mapCompleted(chartBars, chartLenMs, htfBars, htfCloseT, htfVals) {
  const out = new Array(chartBars.length).fill(NA);
  let j = -1;
  for (let i = 0; i < chartBars.length; i++) {
    const cClose = chartBars[i].t + chartLenMs;
    while (j + 1 < htfBars.length && htfCloseT[j + 1] <= cClose) j++;
    if (j >= 0) out[i] = htfVals[j];
  }
  return out;
}

function pina5(chartBars, chartDays, bars1d, bars4h, o = {}) {
  const { maType = "EMA", maLen = 11, useSmooth = true, smoothLen = 5,
          useATR = true, atrLen = 9, atrMult = 0.7, lookback = 19, phase3d = 0 } = o;
  const b3 = aggregateDays(bars1d, 3, phase3d).filter(b => b.full);
  const c3 = col(b3, "close"), atr3 = P.atr(b3, atrLen);
  const upSrc = useATR ? c3.map((c, i) => c + atr3[i] * atrMult) : col(b3, "high");
  const loSrc = useATR ? c3.map((c, i) => c - atr3[i] * atrMult) : col(b3, "low");
  const up = P.highest(upSrc, lookback), lo = P.lowest(loSrc, lookback);
  const base3 = up.map((u, i) => (fin(u) && fin(lo[i]) ? (u + lo[i]) / 2 : NA));

  const chartLen = chartDays * DAY;
  const base = mapCompleted(chartBars, chartLen, b3, b3.map(b => b.closeT), base3);
  const avgMA = maPine(maType, base, maLen, col(chartBars, "vol"));
  const avgLine = useSmooth ? P.sma(avgMA, smoothLen) : avgMA;
  const close = col(chartBars, "close");
  const ema21 = P.ema(close, 21);
  const e200 = P.ema(col(bars4h, "close"), 200);
  const ema200 = mapCompleted(chartBars, chartLen, bars4h, bars4h.map(b => b.t + 4 * 3600000), e200);

  const out = new Array(chartBars.length).fill(-1);
  let pos = 0;
  for (let i = 0; i < chartBars.length; i++) {
    if ([close[i], ema21[i], avgLine[i], ema200[i]].every(fin)) {
      const longC = close[i] > avgLine[i] && ema21[i] > avgLine[i] && close[i] > ema200[i];
      const sellC = close[i] < avgLine[i] && ema21[i] < avgLine[i] && close[i] < ema200[i];
      if (longC) pos = 1;
      else if (sellC) pos = 0;
    }
    out[i] = pos > 0 ? 1 : -1;
  }
  return out;
}

module.exports = { pctST, demaHmaZ, squeeze, emdTrend, followLine, dualPhase, sgMedianRsi, pina5,
                   aggregateDays, sgCoeffs, pivot };
