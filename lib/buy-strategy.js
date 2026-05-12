// User-controlled BUY_LIMIT discount buffer. Forces the AI's orderPrice to be
// at least N dollars below the current price, so the user is never chasing
// pullbacks with marketable limits. Mirrors the existing sell-strategy
// parameterization (quickProfitDelta / maxLossDelta) — same parsing rules,
// same default magnitude, same UI surface.
//
// Real-trade motivation: the prompt's "marketable limit" wording often led to
// fills at near-current price, followed by EMA/VWAP break → SELL_NOW → recovery
// (classic chop kill). A user-set discount makes the entry condition stricter:
// "I'll buy only if price gives me at least $X cushion below where it is now."
// Higher discount = lower risk + lower fill rate. Users explicitly accept
// missing trades in exchange for not chasing.

export const DEFAULT_DIP_BUY_DISCOUNT = "0.20";

function parsePositiveDecimal(value) {
  const raw = `${value ?? ""}`.trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatDollarValue(value) {
  return value.toFixed(2);
}

export function isValidBuyDelta(value) {
  return parsePositiveDecimal(value) !== null;
}

export function normalizeBuyDelta(value, fallback) {
  const parsed = parsePositiveDecimal(value);
  if (parsed !== null) {
    return formatDollarValue(parsed);
  }
  const fallbackParsed = parsePositiveDecimal(fallback);
  return formatDollarValue(fallbackParsed || Number(DEFAULT_DIP_BUY_DISCOUNT));
}

export function normalizeBuyStrategyRules(rules = {}) {
  return {
    dipBuyDiscount: normalizeBuyDelta(rules?.dipBuyDiscount, DEFAULT_DIP_BUY_DISCOUNT)
  };
}

// Returns the maximum allowed BUY_LIMIT orderPrice given a currentPrice and
// the user's discount setting. Returns null if currentPrice is unreadable —
// caller should skip the validation in that case rather than fail open.
export function calculateMaxBuyOrderPrice(currentPrice, rules = {}) {
  const current = parsePositiveDecimal(currentPrice);
  if (current === null) {
    return null;
  }
  const normalizedRules = normalizeBuyStrategyRules(rules);
  const discount = Number(normalizedRules.dipBuyDiscount);
  // Clamp at $0.01 minimum so a misconfigured huge discount on a tiny stock
  // doesn't produce a negative or zero target (which would be unfillable and
  // confusing).
  const max = Math.max(0.01, current - discount);
  return formatDollarValue(max);
}

// Returns context object for prompt injection — currentPrice, discount, and
// the resulting max allowed BUY_LIMIT orderPrice. Null if either input is
// unparseable.
export function buildBuyStrategyContext(currentPrice, rules = {}) {
  const normalizedRules = normalizeBuyStrategyRules(rules);
  const maxOrderPrice = calculateMaxBuyOrderPrice(currentPrice, normalizedRules);
  if (maxOrderPrice === null) {
    return null;
  }
  return {
    currentPrice: formatDollarValue(parsePositiveDecimal(currentPrice)),
    dipBuyDiscount: normalizedRules.dipBuyDiscount,
    maxOrderPrice
  };
}
