// ── Pine Script built-ins, ported to match TradingView semantics ──
// Series are plain arrays ascending in time. `na` is represented as NaN.
// Seeding matters: Pine's ta.ema and ta.rma are na until `length` bars, then
// seeded with the SMA of the first window, then recursive. Getting this wrong
// flips signals near thresholds, so it's replicated exactly here.

const NA = NaN;
const isNa = x => !Number.isFinite(x);
const nz = (x, rep = 0) => (isNa(x) ? rep : x);

// NaN-safe: returns na while the window contains any na (matches Pine ta.sma),
// and never lets a leading-na value poison the running sum (critical for chained
// MAs like TMA = sma(sma(...))).
function sma(src, len) {
  const out = new Array(src.length).fill(NA);
  let sum = 0, nanCount = 0;
  for (let i = 0; i < src.length; i++) {
    if (isNa(src[i])) nanCount++; else sum += src[i];
    if (i >= len) { const o = src[i - len]; if (isNa(o)) nanCount--; else sum -= o; }
    if (i >= len - 1 && nanCount === 0) out[i] = sum / len;
  }
  return out;
}

// Pine ta.ema: na for first len-1 bars, seeded with sma(len), then alpha recursion.
function ema(src, len) {
  const out = new Array(src.length).fill(NA);
  const alpha = 2 / (len + 1);
  const seed = sma(src, len);
  let prev = NA;
  for (let i = 0; i < src.length; i++) {
    if (isNa(prev)) {
      if (!isNa(seed[i])) { out[i] = seed[i]; prev = seed[i]; }
    } else {
      prev = alpha * src[i] + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}

// Pine ta.rma (Wilder): same seeding as ema but alpha = 1/len.
function rma(src, len) {
  const out = new Array(src.length).fill(NA);
  const alpha = 1 / len;
  const seed = sma(src, len);
  let prev = NA;
  for (let i = 0; i < src.length; i++) {
    if (isNa(prev)) {
      if (!isNa(seed[i])) { out[i] = seed[i]; prev = seed[i]; }
    } else {
      prev = alpha * src[i] + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}

function wma(src, len) {
  const out = new Array(src.length).fill(NA);
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let acc = 0;
    for (let k = 0; k < len; k++) acc += src[i - k] * (len - k); // most recent weight = len
    out[i] = acc / denom;
  }
  return out;
}

function vwma(src, vol, len) {
  const pv = src.map((s, i) => s * nz(vol[i]));
  const a = sma(pv, len), b = sma(vol.map(v => nz(v)), len);
  return a.map((x, i) => (isNa(x) || isNa(b[i]) || b[i] === 0 ? NA : x / b[i]));
}

// ta.hma: wma(2*wma(src,len/2) - wma(src,len), round(sqrt(len)))
function hma(src, len) {
  const half = Math.round(len / 2);
  const w1 = wma(src, half), w2 = wma(src, len);
  const diff = src.map((_, i) => (isNa(w1[i]) || isNa(w2[i]) ? NA : 2 * w1[i] - w2[i]));
  // wma over a series with leading NAs: compute only where full window is valid
  return wmaSafe(diff, Math.round(Math.sqrt(len)));
}

// wma that yields NA if any value in the window is NA (needed for chained MAs)
function wmaSafe(src, len) {
  const out = new Array(src.length).fill(NA);
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let acc = 0, ok = true;
    for (let k = 0; k < len; k++) {
      const v = src[i - k];
      if (isNa(v)) { ok = false; break; }
      acc += v * (len - k);
    }
    if (ok) out[i] = acc / denom;
  }
  return out;
}

function trueRange(bars) {
  const out = new Array(bars.length).fill(NA);
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) { out[i] = bars[i].high - bars[i].low; continue; }
    const pc = bars[i - 1].close;
    out[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - pc),
      Math.abs(bars[i].low - pc)
    );
  }
  return out;
}

// ta.atr = rma(trueRange, len)
function atr(bars, len) { return rma(trueRange(bars), len); }

function highest(src, len) {
  const out = new Array(src.length).fill(NA);
  for (let i = len - 1; i < src.length; i++) {
    let m = -Infinity, ok = true;
    for (let k = 0; k < len; k++) { const v = src[i - k]; if (isNa(v)) { ok = false; break; } if (v > m) m = v; }
    if (ok) out[i] = m;
  }
  return out;
}

function lowest(src, len) {
  const out = new Array(src.length).fill(NA);
  for (let i = len - 1; i < src.length; i++) {
    let m = Infinity, ok = true;
    for (let k = 0; k < len; k++) { const v = src[i - k]; if (isNa(v)) { ok = false; break; } if (v < m) m = v; }
    if (ok) out[i] = m;
  }
  return out;
}

// ta.linreg(src, len, offset): value of linear regression line at (len-1-offset)
function linreg(src, len, offset = 0) {
  const out = new Array(src.length).fill(NA);
  for (let i = len - 1; i < src.length; i++) {
    let sx = 0, sy = 0, sxy = 0, sxx = 0, ok = true;
    for (let k = 0; k < len; k++) {
      const x = k;                 // 0 = oldest in window
      const y = src[i - (len - 1 - k)];
      if (isNa(y)) { ok = false; break; }
      sx += x; sy += y; sxy += x * y; sxx += x * x;
    }
    if (!ok) continue;
    const denom = len * sxx - sx * sx;
    if (denom === 0) continue;
    const slope = (len * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / len;
    out[i] = intercept + slope * (len - 1 - offset);
  }
  return out;
}

// ta.roc: percent rate of change over `len` bars.
function roc(src, len) {
  const out = new Array(src.length).fill(NA);
  for (let i = len; i < src.length; i++) {
    const p = src[i - len];
    if (!isNa(src[i]) && !isNa(p) && p !== 0) out[i] = (100 * (src[i] - p)) / p;
  }
  return out;
}

// ta.rsi: RSI via Wilder RMA of gains/losses.
function rsi(src, len) {
  const change = src.map((v, i) => (i === 0 || isNa(v) || isNa(src[i - 1]) ? NA : v - src[i - 1]));
  const up = rma(change.map(c => (isNa(c) ? NA : Math.max(c, 0))), len);
  const down = rma(change.map(c => (isNa(c) ? NA : Math.max(-c, 0))), len);
  return src.map((_, i) => {
    if (isNa(up[i]) || isNa(down[i])) return NA;
    if (down[i] === 0) return 100;
    if (up[i] === 0) return 0;
    return 100 - 100 / (1 + up[i] / down[i]);
  });
}

function stdev(src, len) {
  const out = new Array(src.length).fill(NA);
  const m = sma(src, len);
  for (let i = len - 1; i < src.length; i++) {
    let acc = 0, ok = true;
    for (let k = 0; k < len; k++) { const v = src[i - k]; if (isNa(v)) { ok = false; break; } acc += (v - m[i]) ** 2; }
    if (ok) out[i] = Math.sqrt(acc / len); // Pine ta.stdev is population (biased)
  }
  return out;
}

// Generic MA selector matching common Pine option strings.
function ma(type, src, len, vol) {
  switch ((type || "").toUpperCase()) {
    case "SMA": return sma(src, len);
    case "EMA": return ema(src, len);
    case "RMA": case "WWMA": return rma(src, len);
    case "WMA": return wma(src, len);
    case "VWMA": return vwma(src, vol || src.map(() => 1), len);
    case "HMA": case "HULL": return hma(src, len);
    case "TMA": return sma(sma(src, Math.ceil(len / 2)), Math.floor(len / 2) + 1);
    case "DEMA": { const e1 = ema(src, len), e2 = ema(e1, len);
      return src.map((_, i) => (isNa(e1[i]) || isNa(e2[i]) ? NA : 2 * e1[i] - e2[i])); }
    case "TEMA": { const e1 = ema(src, len), e2 = ema(e1, len), e3 = ema(e2, len);
      return src.map((_, i) => (isNa(e1[i]) || isNa(e2[i]) || isNa(e3[i]) ? NA : 3 * (e1[i] - e2[i]) + e3[i])); }
    case "LSMA": return linreg(src, len, 0);
    default: return ema(src, len);
  }
}

// ta.percentile_nearest_rank(src, len, p): p-th percentile by nearest-rank over
// the last `len` values. Median = p=50. na until the window is full & clean.
function percentileNearestRank(src, len, p) {
  const out = new Array(src.length).fill(NA);
  for (let i = len - 1; i < src.length; i++) {
    const w = []; let ok = true;
    for (let k = 0; k < len; k++) { const v = src[i - k]; if (isNa(v)) { ok = false; break; } w.push(v); }
    if (!ok) continue;
    w.sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * len); // 1-based nearest rank
    out[i] = w[Math.min(Math.max(rank, 1), len) - 1];
  }
  return out;
}

// ta.barssince: bars since `cond` was last true; na until the first true.
function barssince(cond) {
  const out = new Array(cond.length).fill(NA);
  let last = -1;
  for (let i = 0; i < cond.length; i++) {
    if (cond[i]) last = i;
    if (last >= 0) out[i] = i - last;
  }
  return out;
}

const crossover = (a, b, i) => i > 0 && !isNa(a[i]) && !isNa(b[i]) && a[i] > b[i] && a[i - 1] <= b[i - 1];
const crossunder = (a, b, i) => i > 0 && !isNa(a[i]) && !isNa(b[i]) && a[i] < b[i] && a[i - 1] >= b[i - 1];

module.exports = {
  NA, isNa, nz, sma, ema, rma, wma, wmaSafe, vwma, hma, trueRange, atr,
  highest, lowest, linreg, stdev, roc, rsi, ma, barssince, percentileNearestRank, crossover, crossunder,
};
