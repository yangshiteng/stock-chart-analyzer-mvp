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
  assert.deepEqual(normalizeSellStrategyRules({ maxLossDelta: "bad" }), {
    quickProfitDelta: "0.20",
    maxLossDelta: "0.30"
  });
});

test("sell-strategy: calculates quick-profit and max-loss trigger prices", () => {
  assert.deepEqual(calculateSellStrategyLevels("27.00", {
    quickProfitDelta: "0.20",
    maxLossDelta: "0.30"
  }), {
    entryPrice: "27.00",
    quickProfitDelta: "0.20",
    maxLossDelta: "0.30",
    quickProfitPrice: "27.20",
    maxLossPrice: "26.70"
  });
});

test("sell-strategy: builds context from a virtual position", () => {
  assert.deepEqual(buildSellStrategyContext({ entryPrice: "27.80" }, {
    quickProfitDelta: "0.25",
    maxLossDelta: "0.40"
  }), {
    entryPrice: "27.80",
    quickProfitDelta: "0.25",
    maxLossDelta: "0.40",
    quickProfitPrice: "28.05",
    maxLossPrice: "27.40"
  });
});
