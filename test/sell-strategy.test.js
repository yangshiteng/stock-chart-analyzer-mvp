import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSellStrategyContext,
  calculateSellStrategyLevels,
  isValidSellDelta,
  normalizeSellDelta,
  normalizeSellStrategyRules
} from "../lib/sell-strategy.js";

test("sell-strategy: validates positive dollar deltas", () => {
  assert.equal(isValidSellDelta("0.20"), true);
  assert.equal(isValidSellDelta("1"), true);
  assert.equal(isValidSellDelta("0"), false);
  assert.equal(isValidSellDelta("-0.20"), false);
  assert.equal(isValidSellDelta("bad"), false);
});

test("sell-strategy: normalizes deltas to cents", () => {
  assert.equal(normalizeSellDelta("0.2", "0.30"), "0.20");
  assert.equal(normalizeSellDelta("1", "0.30"), "1.00");
  assert.equal(normalizeSellDelta("bad", "0.30"), "0.30");
});

test("sell-strategy: defaults missing or invalid rules", () => {
  assert.deepEqual(normalizeSellStrategyRules({ quickProfitDelta: "bad" }), {
    quickProfitDelta: "0.20"
  });
});

test("sell-strategy: strips legacy maxLossDelta from stored rules", () => {
  // Old profiles carried maxLossDelta. The removed-feature cleanup means
  // normalizeSellStrategyRules now returns ONLY quickProfitDelta. Anything
  // else stays out — including legacy fields like maxLossDelta that callers
  // may still hand us.
  assert.deepEqual(normalizeSellStrategyRules({ quickProfitDelta: "0.25", maxLossDelta: "0.50" }), {
    quickProfitDelta: "0.25"
  });
});

test("sell-strategy: calculates quick-profit trigger price", () => {
  assert.deepEqual(calculateSellStrategyLevels("27.00", {
    quickProfitDelta: "0.20"
  }), {
    entryPrice: "27.00",
    quickProfitDelta: "0.20",
    quickProfitPrice: "27.20"
  });
});

test("sell-strategy: builds context from a virtual position", () => {
  assert.deepEqual(buildSellStrategyContext({ entryPrice: "27.80" }, {
    quickProfitDelta: "0.25"
  }), {
    entryPrice: "27.80",
    quickProfitDelta: "0.25",
    quickProfitPrice: "28.05"
  });
});
