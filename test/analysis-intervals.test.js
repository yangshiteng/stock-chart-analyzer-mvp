import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getActiveAnalysisIntervalRule,
  getAnalysisPhase,
  getIntervalRecommendationKey,
  normalizeAnalysisInterval,
  normalizeAnalysisIntervalRules
} from "../lib/analysis-intervals.js";

test("analysis-intervals: normalizes single interval values", () => {
  assert.equal(normalizeAnalysisInterval("1m"), "1m");
  assert.equal(normalizeAnalysisInterval(" 10m "), "10m");
  assert.equal(normalizeAnalysisInterval("bad"), "5m");
  assert.equal(normalizeAnalysisInterval("bad", "2m"), "2m");
});

test("analysis-intervals: splits legacy analysisInterval into entry default only", () => {
  assert.deepEqual(normalizeAnalysisIntervalRules({ analysisInterval: "10m" }), {
    entryInterval: "10m",
    pendingInterval: "2m",
    positionInterval: "1m"
  });
});

test("analysis-intervals: defaults missing rules by trading state", () => {
  assert.deepEqual(normalizeAnalysisIntervalRules(), {
    entryInterval: "5m",
    pendingInterval: "2m",
    positionInterval: "1m"
  });
});

test("analysis-intervals: invalid split rules fall back independently", () => {
  assert.deepEqual(
    normalizeAnalysisIntervalRules({
      analysisInterval: "15m",
      entryInterval: "bad",
      pendingInterval: "30m",
      positionInterval: "also-bad"
    }),
    {
      entryInterval: "15m",
      pendingInterval: "30m",
      positionInterval: "1m"
    }
  );
});

test("analysis-intervals: detects active analysis phase", () => {
  assert.equal(getAnalysisPhase({}), "entry");
  assert.equal(getAnalysisPhase({ pendingLimitOrder: { action: "BUY_LIMIT" } }), "pending");
  assert.equal(
    getAnalysisPhase({
      pendingLimitOrder: { action: "SELL_LIMIT" },
      virtualPosition: { entryPrice: "27.80" }
    }),
    "position"
  );
});

test("analysis-intervals: chooses interval from current trading state", () => {
  const rules = {
    entryInterval: "5m",
    pendingInterval: "2m",
    positionInterval: "1m"
  };

  assert.equal(getActiveAnalysisIntervalRule({}, rules), "5m");
  assert.equal(getActiveAnalysisIntervalRule({ pendingLimitOrder: { action: "BUY_LIMIT" } }, rules), "2m");
  assert.equal(getActiveAnalysisIntervalRule({ virtualPosition: { entryPrice: "27.80" } }, rules), "1m");
});

test("analysis-intervals: recommendation key follows regular session windows", () => {
  assert.equal(getIntervalRecommendationKey(new Date("2026-01-05T14:29:00Z")), "outside");
  assert.equal(getIntervalRecommendationKey(new Date("2026-01-05T14:30:00Z")), "morning");
  assert.equal(getIntervalRecommendationKey(new Date("2026-01-05T15:29:00Z")), "morning");
  assert.equal(getIntervalRecommendationKey(new Date("2026-01-05T15:30:00Z")), "midday");
  assert.equal(getIntervalRecommendationKey(new Date("2026-01-05T20:30:00Z")), "late");
  assert.equal(getIntervalRecommendationKey(new Date("2026-01-05T21:00:00Z")), "outside");
  assert.equal(getIntervalRecommendationKey(new Date("2026-01-10T17:00:00Z")), "outside");
});
