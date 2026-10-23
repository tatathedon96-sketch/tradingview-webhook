// ── ALT/ALT tiebreaker matrix ──
// For a short list of tournament finalists, score the shared TPI basket on every
// synthetic A/B ratio (A's USD bars divided by B's, component-wise like
// TradingView). cell[i][j] = basket score of tickers[i] / tickers[j] (-1..+1).
// The sheet turns that into the course's 1/0 table: row beats column when > 0.
// Each token's USD bars are fetched ONCE; n tokens → n fetches + n(n-1)/2 scorings.

const { fetchDailyPair } = require("./fetch_ohlc");
const { scoreBars, synthRatio } = require("./score_basket");

async function altMatrix(tickers) {
  const T = [...new Set(tickers.map(t => String(t).trim().toUpperCase()).filter(Boolean))];
  const bars = {}, errors = {};
  await Promise.all(T.map(async t => {
    try { bars[t] = (await fetchDailyPair(t + "USDT", 400)).bars; }
    catch (e) { errors[t] = e.message; }
  }));

  const n = T.length;
  const cell = Array.from({ length: n }, () => new Array(n).fill(null));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = bars[T[i]], b = bars[T[j]];
      if (!a || !b) continue;
      const ab = synthRatio(a, b, true), ba = synthRatio(b, a, true);
      if (ab.length < 30) continue;
      cell[i][j] = scoreBars(ab).score;
      cell[j][i] = scoreBars(ba).score; // scored separately, not assumed to be -cell[i][j]
    }
  }
  const wins = T.map((_, i) => cell[i].reduce((s, v, j) => s + (i !== j && v > 0 ? 1 : 0), 0));
  return { tickers: T, matrix: cell, wins, errors };
}

module.exports = { altMatrix };

// Demo: `node alt_matrix.js SUI APT NEAR`
if (require.main === module) {
  altMatrix(process.argv.slice(2)).then(r => console.log(JSON.stringify(r, null, 1)));
}
