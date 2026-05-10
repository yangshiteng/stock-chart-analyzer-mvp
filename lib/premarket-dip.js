import { getUsMarketMinutesOfDay } from "./market-hours.js";

export const PREMARKET_DIP_DISCOUNT_PERCENT = 10;
export const PREMARKET_DIP_WINDOW_START_MINUTE = 4 * 60;
export const PREMARKET_DIP_WINDOW_END_MINUTE = 9 * 60 + 30;

export function isWithinPremarketDipWindow(now = new Date()) {
  const minutesOfDay = getUsMarketMinutesOfDay(now);
  return minutesOfDay !== null
    && minutesOfDay >= PREMARKET_DIP_WINDOW_START_MINUTE
    && minutesOfDay < PREMARKET_DIP_WINDOW_END_MINUTE;
}

export function normalizePositiveDecimal(value, fieldName = "price") {
  const raw = `${value ?? ""}`.trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error(`${fieldName} must be a positive decimal price.`);
  }

  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive decimal price.`);
  }

  return raw;
}

export function calculatePremarketDipReferencePrice(referenceClose, discountPercent = PREMARKET_DIP_DISCOUNT_PERCENT) {
  const closeRaw = normalizePositiveDecimal(referenceClose, "referenceClose");
  const close = Number(closeRaw);
  return (close * (1 - discountPercent / 100)).toFixed(2);
}

export function buildPendingLimitOrderFromPremarketPlan(plan, {
  now = new Date(),
  sourceRound = 0,
  sourcePlanId = null,
  symbol = null
} = {}) {
  if (!plan || typeof plan !== "object") {
    throw new Error("Premarket dip plan is missing.");
  }

  if (plan.action !== "BUY_LIMIT") {
    throw new Error("Premarket dip plan must be a BUY_LIMIT plan.");
  }

  const limitPrice = normalizePositiveDecimal(plan.orderPrice, "orderPrice");
  const stopLossPrice = plan.stopLossPrice === null || plan.stopLossPrice === undefined || plan.stopLossPrice === ""
    ? null
    : normalizePositiveDecimal(plan.stopLossPrice, "stopLossPrice");
  const targetPrice = plan.targetPrice === null || plan.targetPrice === undefined || plan.targetPrice === ""
    ? null
    : normalizePositiveDecimal(plan.targetPrice, "targetPrice");
  const normalizedSymbol = `${symbol || plan.symbol || ""}`.trim().toUpperCase() || null;

  return {
    action: "BUY_LIMIT",
    limitPrice,
    stopLossPrice,
    targetPrice,
    reasoning: plan.reasoning || null,
    confidence: ["low", "medium", "high"].includes(plan.confidence) ? plan.confidence : null,
    symbol: normalizedSymbol,
    placedAt: now.toISOString(),
    sourceRound,
    source: "premarket_dip_plan",
    sourcePlanId
  };
}
