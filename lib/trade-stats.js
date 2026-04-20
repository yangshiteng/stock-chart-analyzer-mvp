// Pure aggregation over state.tradeHistory. No side effects.
// Abandoned trades (overnight auto-close with no fill price) are excluded
// because they have no pnlPercent — they would skew every metric.

const ACTION_BUCKETS = ["BUY_NOW", "BUY_LIMIT"];
const CONFIDENCE_BUCKETS = ["high", "medium", "low"];

function aggregate(trades) {
  if (trades.length === 0) {
    return {
      n: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      avgPnlPercent: null,
      totalPnlPercent: null,
      avgHeldMinutes: null,
      bestPnlPercent: null,
      worstPnlPercent: null
    };
  }

  const pnls = trades.map((t) => t.pnlPercent);
  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p < 0).length;
  const totalPnlPercent = pnls.reduce((s, p) => s + p, 0);
  const avgPnlPercent = totalPnlPercent / trades.length;

  const heldMinutes = trades
    .map((t) => t.heldMinutes)
    .filter((m) => Number.isFinite(m));
  const avgHeldMinutes = heldMinutes.length > 0
    ? heldMinutes.reduce((s, m) => s + m, 0) / heldMinutes.length
    : null;

  return {
    n: trades.length,
    wins,
    losses,
    // Breakeven (pnl === 0) counts as neither win nor loss; denominator is still n.
    winRate: wins / trades.length,
    avgPnlPercent,
    totalPnlPercent,
    avgHeldMinutes,
    bestPnlPercent: Math.max(...pnls),
    worstPnlPercent: Math.min(...pnls)
  };
}

function groupBy(trades, keyFn, knownBuckets) {
  const buckets = new Map();
  for (const key of knownBuckets) {
    buckets.set(key, []);
  }
  for (const trade of trades) {
    const key = keyFn(trade);
    const bucketKey = knownBuckets.includes(key) ? key : "unknown";
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, []);
    }
    buckets.get(bucketKey).push(trade);
  }
  const result = {};
  for (const [key, group] of buckets) {
    result[key] = aggregate(group);
  }
  return result;
}

export function computeTradeStats(tradeHistory) {
  const list = Array.isArray(tradeHistory) ? tradeHistory : [];
  const valid = list.filter(
    (t) => t && t.status !== "abandoned" && Number.isFinite(t.pnlPercent)
  );

  return {
    overall: aggregate(valid),
    byAction: groupBy(valid, (t) => t.entryAction, ACTION_BUCKETS),
    byConfidence: groupBy(valid, (t) => t.entryConfidence, CONFIDENCE_BUCKETS)
  };
}

export { ACTION_BUCKETS, CONFIDENCE_BUCKETS };
