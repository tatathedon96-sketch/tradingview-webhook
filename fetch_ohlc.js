// ── Keyless OHLC fetch (extends server.js closes-only pattern to full OHLC) ──
// Returns bars ascending in time: { t, open, high, low, close } (t = ms epoch of bar open)
// Direct pair fetch (Binance/OKX/KuCoin) when the symbol exists on the exchange;
// ratio synthesis is a fallback for token/BTC pairs that aren't listed directly.

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// Each source returns ascending OHLC bars or throws. `pair` is exchange-native (e.g. ETHBTC).
const SOURCES = {
  async binance(pair, limit) {
    // klines row: [openTime, open, high, low, close, vol, ...]
    const j = await getJSON(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=${Math.min(limit, 1000)}`
    );
    if (!Array.isArray(j)) throw new Error(`binance: ${(j && j.msg) || "bad response"}`);
    return j.map(r => ({ t: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], vol: +r[5] }));
  },
  async okx(pair, limit) {
    // instId uses BASE-QUOTE; row: [ts, o, h, l, c, ...] newest-first
    const instId = pair.replace(/(BTC|ETH|USDT|USDC|USD)$/, "-$1");
    const j = await getJSON(
      `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=1Dutc&limit=${Math.min(limit, 300)}`
    );
    if (j.code !== "0" || !Array.isArray(j.data)) throw new Error(`okx: ${j.msg || j.code}`);
    return j.data
      .map(r => ({ t: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], vol: +r[5] }))
      .reverse();
  },
  async kucoin(pair, limit) {
    // symbol uses BASE-QUOTE; row: [time(s), open, close, high, low, ...] newest-first
    const sym = pair.replace(/(BTC|ETH|USDT|USDC|USD)$/, "-$1");
    const end = Math.floor(Date.now() / 1000);
    const start = end - (limit + 2) * 86400;
    const j = await getJSON(
      `https://api.kucoin.com/api/v1/market/candles?type=1day&symbol=${sym}&startAt=${start}&endAt=${end}`
    );
    if (j.code !== "200000" || !Array.isArray(j.data)) throw new Error(`kucoin: ${j.msg || j.code}`);
    return j.data
      .map(r => ({ t: +r[0] * 1000, open: +r[1], high: +r[3], low: +r[4], close: +r[2], vol: +r[5] }))
      .reverse();
  },
};
const ORDER = ["binance", "okx", "kucoin"];

function validBars(bars) {
  const ok = (bars || []).filter(
    b => [b.open, b.high, b.low, b.close].every(x => Number.isFinite(x) && x > 0)
  );
  return ok.length >= 20 ? ok : null;
}

// Fetch a directly-listed pair (e.g. "ETHBTC") as daily OHLC.
async function fetchDailyPair(pair, limit = 400) {
  const errors = [];
  for (const name of ORDER) {
    try {
      await sleep(20);
      const bars = validBars(await SOURCES[name](pair, limit));
      if (!bars) throw new Error(`${name}: not enough data`);
      return { source: name, bars: bars.slice(-limit) };
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(`No daily OHLC for ${pair} (${errors.join("; ")})`);
}

// ── Fetch a pair at an arbitrary interval (e.g. "3d", "4h") ──
// Binance serves 3d/4h natively (UTC-anchored, matching TradingView); OKX fallback.
async function fetchInterval(pair, interval, limit = 500) {
  const errors = [];
  // Binance
  try {
    await sleep(20);
    const j = await getJSON(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${Math.min(limit, 1000)}`
    );
    if (Array.isArray(j)) {
      const bars = validBars(j.map(r => ({ t: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], vol: +r[5] })));
      if (bars) return { source: "binance", bars: bars.slice(-limit) };
    } else errors.push(`binance: ${(j && j.msg) || "bad"}`);
  } catch (e) { errors.push("binance: " + e.message); }
  // OKX fallback (bar codes: 3d->3Dutc, 4h->4H)
  try {
    const bar = interval === "3d" ? "3Dutc" : interval === "4h" ? "4H" : interval.toUpperCase();
    const instId = pair.replace(/(BTC|ETH|USDT|USDC|USD)$/, "-$1");
    const j = await getJSON(
      `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${Math.min(limit, 300)}`
    );
    if (j.code === "0" && Array.isArray(j.data)) {
      const bars = validBars(j.data.map(r => ({ t: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], vol: +r[5] })).reverse());
      if (bars) return { source: "okx", bars: bars.slice(-limit) };
    } else errors.push(`okx: ${j.msg || j.code}`);
  } catch (e) { errors.push("okx: " + e.message); }
  throw new Error(`No ${interval} data for ${pair} (${errors.join("; ")})`);
}

// Map an HTF value series onto daily bars by timestamp (request.security, lookahead_off
// flavor): for each daily bar, take the HTF bar whose open-time is the latest at or
// before that day's close. Works for coarser HTF (3D → containing bar) and finer HTF
// (4H → last 4H bar of the day). Both arrays must be ascending in time.
function mapHtfToDaily(dailyBars, htfBars, htfValues) {
  const out = new Array(dailyBars.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < dailyBars.length; i++) {
    const cutoff = dailyBars[i].t + 86400000 - 1;
    while (j + 1 < htfBars.length && htfBars[j + 1].t <= cutoff) j++;
    if (htfBars[j] && htfBars[j].t <= cutoff) out[i] = htfValues[j];
  }
  return out;
}

// ── HTF aggregation: fold N daily bars into one (for 2D / 3D) ──
// NOTE: TradingView anchors multi-day bars to a fixed epoch; this simple
// left-to-right grouping can differ by a phase offset near the current bar.
// Good enough for validation; anchor-exact alignment is a later refinement.
function aggregate(bars, n) {
  if (n <= 1) return bars.slice();
  const out = [];
  for (let i = 0; i < bars.length; i += n) {
    const grp = bars.slice(i, i + n);
    if (!grp.length) continue;
    out.push({
      t: grp[0].t,
      open: grp[0].open,
      high: Math.max(...grp.map(b => b.high)),
      low: Math.min(...grp.map(b => b.low)),
      close: grp[grp.length - 1].close,
      vol: grp.reduce((s, b) => s + (b.vol || 0), 0),
    });
  }
  return out;
}

module.exports = { fetchDailyPair, fetchInterval, mapHtfToDaily, aggregate };

// Quick manual probe: `node fetch_ohlc.js ETHBTC`
if (require.main === module) {
  (async () => {
    const pair = process.argv[2] || "ETHBTC";
    const { source, bars } = await fetchDailyPair(pair, 60);
    const last = bars[bars.length - 1];
    console.log(`${pair}: ${bars.length} daily bars from ${source}`);
    console.log(`  latest bar t=${new Date(last.t).toISOString().slice(0, 10)} ` +
      `O=${last.open} H=${last.high} L=${last.low} C=${last.close}`);
  })().catch(e => { console.error("ERR:", e.message); process.exit(1); });
}
