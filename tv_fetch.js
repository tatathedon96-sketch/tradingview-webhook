// ── Keyless TradingView data-socket client ──
// Pulls daily/2-day OHLCV for a public index symbol (e.g. CRYPTOCAP:TOTALES)
// straight from TradingView's own websocket — no API key, no login, no browser.
// Returns the exact series the user's chart is built on (same data + volume),
// so ported indicators match what they'd read by hand.
//
// Node 22+ ships a global WebSocket (undici); no external deps.

const WS_URL =
  "wss://data.tradingview.com/socket.io/websocket?from=chart%2F&type=chart";

function frame(s) {
  return `~m~${s.length}~m~${s}`;
}
function msg(m, p) {
  return frame(JSON.stringify({ m, p }));
}
function rid(prefix) {
  return prefix + Math.random().toString(36).slice(2, 14);
}

// Fetch `bars` most-recent candles of `symbol` at `resolution` ("1D","2D","3D"...).
// Resolves to ascending bars: { t (ms epoch, bar open), open, high, low, close, vol }.
function fetchTV(symbol, resolution = "1D", bars = 400, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const csId = rid("cs_");
    const symId = "sds_sym_1";
    const seriesId = "sds_1";
    let buffer = "";
    let settled = false;

    const ws = new WebSocket(WS_URL, {
      headers: { Origin: "https://www.tradingview.com" },
    });

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(
      () => finish(new Error(`TV timeout for ${symbol} ${resolution}`)),
      timeoutMs
    );

    ws.addEventListener("open", () => {
      ws.send(msg("set_auth_token", ["unauthorized_user_token"]));
      ws.send(msg("chart_create_session", [csId, ""]));
      ws.send(msg("resolve_symbol", [
        csId, symId, `={"symbol":"${symbol}","adjustment":"splits"}`,
      ]));
      ws.send(msg("create_series", [csId, seriesId, "s1", symId, resolution, bars, ""]));
    });

    ws.addEventListener("error", (e) => finish(new Error("WS error: " + (e.message || e))));
    ws.addEventListener("close", () => {
      if (!settled) finish(new Error(`TV closed before data for ${symbol}`));
    });

    ws.addEventListener("message", (ev) => {
      buffer += ev.data;
      const re = /~m~(\d+)~m~/g;
      let m, consumedTo = 0;
      const packets = [];
      while ((m = re.exec(buffer)) !== null) {
        const len = parseInt(m[1], 10);
        const start = m.index + m[0].length;
        const payload = buffer.slice(start, start + len);
        if (payload.length < len) break; // wait for the rest
        packets.push(payload);
        consumedTo = start + len;
        re.lastIndex = consumedTo;
      }
      buffer = buffer.slice(consumedTo);

      for (const p of packets) {
        if (p.startsWith("~h~")) { ws.send(frame(p)); continue; } // heartbeat echo
        let obj;
        try { obj = JSON.parse(p); } catch { continue; }
        if (obj.m === "critical_error" || obj.m === "symbol_error" || obj.m === "series_error") {
          finish(new Error(`${obj.m}: ${JSON.stringify(obj.p)}`));
          return;
        }
        if (obj.m === "timescale_update" || obj.m === "du") {
          const d = obj.p && obj.p[1];
          const s = d && d[seriesId] && d[seriesId].s;
          if (s && s.length) {
            const out = s
              .map((x) => x.v)
              .filter((v) => v && Number.isFinite(v[1]))
              .map((v) => ({
                t: v[0] * 1000,
                open: v[1], high: v[2], low: v[3], close: v[4],
                vol: Number.isFinite(v[5]) ? v[5] : 0,
              }));
            if (out.length) finish(null, out);
          }
        }
      }
    });
  });
}

// ── Aggregate 1D bars into n-day bars (for 2D/3D indicators) ──
// TradingView anchors multi-day bars to a fixed epoch phase. Keyless feeds reject
// "2D"/"3D" as custom resolutions, so we fold 1D bars ourselves. `phase` (0..n-1)
// selects which epoch-day boundary starts a bucket; the right phase is the one that
// reproduces the chart, chosen empirically against the hand-scored column.
function aggregate(bars, n, phase = 0) {
  if (n <= 1) return bars.slice();
  const DAY = 86400000;
  const groups = new Map();
  for (const b of bars) {
    const dayIdx = Math.floor(b.t / DAY);
    const bucket = Math.floor((dayIdx - phase) / n);
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(b);
  }
  const out = [];
  for (const bucket of [...groups.keys()].sort((a, b) => a - b)) {
    const g = groups.get(bucket).sort((a, b) => a.t - b.t);
    out.push({
      t: g[0].t,
      open: g[0].open,
      high: Math.max(...g.map((x) => x.high)),
      low: Math.min(...g.map((x) => x.low)),
      close: g[g.length - 1].close,
      vol: g.reduce((s, x) => s + (x.vol || 0), 0),
    });
  }
  return out;
}

// Map an n-day aggregated series back onto the 1D timeline: each daily bar takes the
// value of the aggregated bar that contains it (request.security lookahead_off style).
function mapAggToDaily(dailyBars, aggBars, aggValues, n, phase = 0) {
  const DAY = 86400000;
  const byBucket = new Map();
  aggBars.forEach((b, i) => {
    const bucket = Math.floor((Math.floor(b.t / DAY) - phase) / n);
    byBucket.set(bucket, aggValues[i]);
  });
  return dailyBars.map((b) => {
    const bucket = Math.floor((Math.floor(b.t / DAY) - phase) / n);
    const v = byBucket.get(bucket);
    return v === undefined ? NaN : v;
  });
}

module.exports = { fetchTV, aggregate, mapAggToDaily };

// Manual probe: node tv_fetch.js CRYPTOCAP:TOTALES 2D 30
if (require.main === module) {
  (async () => {
    const [sym = "CRYPTOCAP:TOTALES", res = "1D", n = "10"] = process.argv.slice(2);
    const bars = await fetchTV(sym, res, parseInt(n, 10));
    const f = (b) =>
      `${new Date(b.t).toISOString().slice(0, 10)}  O=${b.open.toExponential(4)} C=${b.close.toExponential(4)} V=${b.vol.toExponential(3)}`;
    console.log(`${sym} @${res}: ${bars.length} bars`);
    console.log("first:", f(bars[0]));
    bars.slice(-4).forEach((b) => console.log("  ", f(b)));
  })().catch((e) => { console.error("ERR", e.message); process.exit(1); });
}
