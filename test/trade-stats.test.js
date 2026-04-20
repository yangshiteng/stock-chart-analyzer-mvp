import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTradeStats } from "../lib/trade-stats.js";

const T = (overrides) => ({
  id: "x",
  symbol: "TSLA",
  pnlPercent: 1.0,
  heldMinutes: 30,
  entryAction: "BUY_NOW",
  entryConfidence: "high",
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

test("trade-stats: breakdown by action", () => {
  const stats = computeTradeStats([
    T({ pnlPercent: 2, entryAction: "BUY_NOW" }),
    T({ pnlPercent: -1, entryAction: "BUY_NOW" }),
    T({ pnlPercent: 1.5, entryAction: "BUY_LIMIT" })
  ]);
  assert.equal(stats.byAction.BUY_NOW.n, 2);
  assert.equal(stats.byAction.BUY_NOW.winRate, 0.5);
  assert.equal(stats.byAction.BUY_LIMIT.n, 1);
  assert.equal(stats.byAction.BUY_LIMIT.winRate, 1);
});

test("trade-stats: breakdown by confidence", () => {
  const stats = computeTradeStats([
    T({ pnlPercent: 2, entryConfidence: "high" }),
    T({ pnlPercent: 1, entryConfidence: "high" }),
    T({ pnlPercent: -1, entryConfidence: "medium" }),
    T({ pnlPercent: -2, entryConfidence: "low" })
  ]);
  assert.equal(stats.byConfidence.high.n, 2);
  assert.equal(stats.byConfidence.high.winRate, 1);
  assert.equal(stats.byConfidence.medium.n, 1);
  assert.equal(stats.byConfidence.medium.winRate, 0);
  assert.equal(stats.byConfidence.low.n, 1);
});

test("trade-stats: legacy trades with null action bucket under 'unknown'", () => {
  const stats = computeTradeStats([
    T({ pnlPercent: 1, entryAction: null, entryConfidence: null }),
    T({ pnlPercent: -1, entryAction: "BUY_NOW", entryConfidence: "high" })
  ]);
  assert.equal(stats.byAction.unknown.n, 1);
  assert.equal(stats.byAction.BUY_NOW.n, 1);
  assert.equal(stats.byConfidence.unknown.n, 1);
  assert.equal(stats.byConfidence.high.n, 1);
});

test("trade-stats: known buckets always present even when empty", () => {
  const stats = computeTradeStats([
    T({ pnlPercent: 1, entryAction: "BUY_NOW", entryConfidence: "high" })
  ]);
  // BUY_LIMIT, medium, low should exist with n=0 for stable UI rendering
  assert.equal(stats.byAction.BUY_LIMIT.n, 0);
  assert.equal(stats.byConfidence.medium.n, 0);
  assert.equal(stats.byConfidence.low.n, 0);
});
