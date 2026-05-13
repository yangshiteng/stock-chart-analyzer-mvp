import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTradeStats } from "../lib/trade-stats.js";

const T = (overrides) => ({
  id: "x",
  symbol: "TSLA",
  pnlPercent: 1.0,
  heldMinutes: 30,
  entryAction: "BUY_LIMIT",
  ...overrides
});

test("trade-stats: empty input returns n=0 overall", () => {
  const stats = computeTradeStats([]);
  assert.equal(stats.overall.n, 0);
  assert.equal(stats.overall.winRate, null);
  assert.equal(stats.overall.avgPnlPercent, null);
});

test("trade-stats: null input tolerated", () => {
  const stats = computeTradeStats(null);
  assert.equal(stats.overall.n, 0);
});

test("trade-stats: excludes abandoned trades entirely", () => {
  const stats = computeTradeStats([
    T({ pnlPercent: 2 }),
    { id: "z", status: "abandoned", pnlPercent: null }
  ]);
  assert.equal(stats.overall.n, 1);
  assert.equal(stats.overall.avgPnlPercent, 2);
});

test("trade-stats: excludes trades with non-finite pnlPercent", () => {
  const stats = computeTradeStats([
    T({ pnlPercent: 1 }),
    T({ pnlPercent: null }),
    T({ pnlPercent: NaN })
  ]);
  assert.equal(stats.overall.n, 1);
});

test("trade-stats: win rate math", () => {
  // 2 wins, 1 loss, 1 breakeven → winRate = 2/4 = 0.5
  const stats = computeTradeStats([
    T({ pnlPercent: 2 }),
    T({ pnlPercent: 1 }),
    T({ pnlPercent: -1.5 }),
    T({ pnlPercent: 0 })
  ]);
  assert.equal(stats.overall.n, 4);
  assert.equal(stats.overall.wins, 2);
  assert.equal(stats.overall.losses, 1);
  assert.equal(stats.overall.winRate, 0.5);
  assert.equal(stats.overall.totalPnlPercent, 1.5);
  assert.equal(stats.overall.avgPnlPercent, 0.375);
  assert.equal(stats.overall.bestPnlPercent, 2);
  assert.equal(stats.overall.worstPnlPercent, -1.5);
});

test("trade-stats: avgHeldMinutes ignores non-finite values", () => {
  const stats = computeTradeStats([
    T({ pnlPercent: 1, heldMinutes: 30 }),
    T({ pnlPercent: -1, heldMinutes: 90 }),
    T({ pnlPercent: 0.5, heldMinutes: null })
  ]);
  assert.equal(stats.overall.n, 3);
  assert.equal(stats.overall.avgHeldMinutes, 60);
});

test("trade-stats: no byConfidence breakdown (field removed)", () => {
  // Confidence was removed entirely (schema, prompt, UI, stats) because LLM
  // self-rated confidence didn't differentiate winners from losers across
  // multi-week real-trade testing. Lock the regression: computeTradeStats
  // returns ONLY overall, no buckets.
  const stats = computeTradeStats([
    T({ pnlPercent: 2 }),
    T({ pnlPercent: -1 })
  ]);
  assert.deepEqual(Object.keys(stats), ["overall"]);
  assert.ok(!("byConfidence" in stats));
});

test("trade-stats: legacy trades with leftover entryConfidence field are ignored", () => {
  // Old trade journal rows may still carry an entryConfidence field on disk.
  // computeTradeStats must not key on it or surface it. We aggregate the
  // overall block normally regardless.
  const stats = computeTradeStats([
    T({ pnlPercent: 1, entryConfidence: "high" }),
    T({ pnlPercent: -1, entryConfidence: "low" })
  ]);
  assert.equal(stats.overall.n, 2);
  assert.equal(stats.overall.winRate, 0.5);
});
