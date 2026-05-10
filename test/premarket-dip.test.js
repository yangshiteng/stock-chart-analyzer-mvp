import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPendingLimitOrderFromPremarketPlan,
  calculatePremarketDipReferencePrice,
  isWithinPremarketDipWindow
} from "../lib/premarket-dip.js";

test("premarket dip: 03:59 ET is outside the window", () => {
  assert.equal(isWithinPremarketDipWindow(new Date("2026-01-05T08:59:00Z")), false);
});

test("premarket dip: 04:00 ET is inside the window", () => {
  assert.equal(isWithinPremarketDipWindow(new Date("2026-01-05T09:00:00Z")), true);
});

test("premarket dip: 09:29 ET is inside the window", () => {
  assert.equal(isWithinPremarketDipWindow(new Date("2026-01-05T14:29:00Z")), true);
});

test("premarket dip: 09:30 ET is outside the window", () => {
  assert.equal(isWithinPremarketDipWindow(new Date("2026-01-05T14:30:00Z")), false);
});

test("premarket dip: weekend is outside the window", () => {
  assert.equal(isWithinPremarketDipWindow(new Date("2026-01-10T14:00:00Z")), false);
});

test("premarket dip: reference price uses fixed 10% discount", () => {
  assert.equal(calculatePremarketDipReferencePrice("27.42"), "24.68");
});

test("premarket dip: adopting a plan creates a standard pendingLimitOrder", () => {
  const now = new Date("2026-01-05T13:00:00Z");
  const pending = buildPendingLimitOrderFromPremarketPlan(
    {
      action: "BUY_LIMIT",
      symbol: "USAR",
      orderPrice: "24.70",
      stopLossPrice: "24.00",
      targetPrice: "25.60",
      confidence: "medium",
      reasoning: "Near daily support."
    },
    {
      now,
      sourceRound: 0,
      sourcePlanId: "plan-1"
    }
  );

  assert.deepEqual(pending, {
    action: "BUY_LIMIT",
    limitPrice: "24.70",
    stopLossPrice: "24.00",
    targetPrice: "25.60",
    reasoning: "Near daily support.",
    confidence: "medium",
    symbol: "USAR",
    placedAt: now.toISOString(),
    sourceRound: 0,
    source: "premarket_dip_plan",
    sourcePlanId: "plan-1"
  });
});
