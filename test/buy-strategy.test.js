import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DIP_BUY_DISCOUNT,
  buildBuyStrategyContext,
  calculateMaxBuyOrderPrice,
  isValidBuyDelta,
  normalizeBuyDelta,
  normalizeBuyStrategyRules
} from "../lib/buy-strategy.js";

test("isValidBuyDelta: accepts positive decimal strings", () => {
  assert.equal(isValidBuyDelta("0.20"), true);
  assert.equal(isValidBuyDelta("1.5"), true);
  assert.equal(isValidBuyDelta("0.01"), true);
});

test("isValidBuyDelta: rejects non-positive / non-decimal input", () => {
  assert.equal(isValidBuyDelta(""), false);
  assert.equal(isValidBuyDelta("-0.5"), false);
  assert.equal(isValidBuyDelta("0"), false);
  assert.equal(isValidBuyDelta("abc"), false);
  assert.equal(isValidBuyDelta(null), false);
  assert.equal(isValidBuyDelta(undefined), false);
  assert.equal(isValidBuyDelta("0.20.5"), false);
});

test("normalizeBuyDelta: uses fallback when input invalid", () => {
  assert.equal(normalizeBuyDelta("invalid", "0.30"), "0.30");
  assert.equal(normalizeBuyDelta(null, "0.50"), "0.50");
  assert.equal(normalizeBuyDelta("", "0.40"), "0.40");
});

test("normalizeBuyDelta: falls back to DEFAULT when fallback also invalid", () => {
  assert.equal(normalizeBuyDelta("bad", "also-bad"), DEFAULT_DIP_BUY_DISCOUNT);
});

test("normalizeBuyStrategyRules: applies default when field missing", () => {
  const rules = normalizeBuyStrategyRules({});
  assert.equal(rules.dipBuyDiscount, DEFAULT_DIP_BUY_DISCOUNT);
});

test("normalizeBuyStrategyRules: preserves valid user setting", () => {
  const rules = normalizeBuyStrategyRules({ dipBuyDiscount: "0.50" });
  assert.equal(rules.dipBuyDiscount, "0.50");
});

test("calculateMaxBuyOrderPrice: subtracts discount from currentPrice", () => {
  // $28.00 - $0.30 = $27.70
  assert.equal(calculateMaxBuyOrderPrice("28.00", { dipBuyDiscount: "0.30" }), "27.70");
  // $182.45 - $0.20 = $182.25
  assert.equal(calculateMaxBuyOrderPrice("182.45", { dipBuyDiscount: "0.20" }), "182.25");
});

test("calculateMaxBuyOrderPrice: returns null when currentPrice invalid", () => {
  assert.equal(calculateMaxBuyOrderPrice("N/A", { dipBuyDiscount: "0.20" }), null);
  assert.equal(calculateMaxBuyOrderPrice(null, { dipBuyDiscount: "0.20" }), null);
  assert.equal(calculateMaxBuyOrderPrice("0", { dipBuyDiscount: "0.20" }), null);
});

test("calculateMaxBuyOrderPrice: clamps at $0.01 floor", () => {
  // Pathological case: huge discount on tiny stock would go negative.
  // Caller's responsibility to set a sensible discount, but we guard.
  assert.equal(calculateMaxBuyOrderPrice("0.50", { dipBuyDiscount: "10.00" }), "0.01");
});

test("calculateMaxBuyOrderPrice: uses default when discount missing", () => {
  // $28.00 - $0.20 (default) = $27.80
  assert.equal(calculateMaxBuyOrderPrice("28.00"), "27.80");
  assert.equal(calculateMaxBuyOrderPrice("28.00", {}), "27.80");
});

test("buildBuyStrategyContext: full context object for prompt injection", () => {
  const ctx = buildBuyStrategyContext("28.00", { dipBuyDiscount: "0.30" });
  assert.deepEqual(ctx, {
    currentPrice: "28.00",
    dipBuyDiscount: "0.30",
    maxOrderPrice: "27.70"
  });
});

test("buildBuyStrategyContext: returns null when currentPrice unreadable", () => {
  assert.equal(buildBuyStrategyContext("N/A", { dipBuyDiscount: "0.30" }), null);
  assert.equal(buildBuyStrategyContext(null, { dipBuyDiscount: "0.30" }), null);
});
