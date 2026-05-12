export const DEFAULT_QUICK_PROFIT_DELTA = "0.20";

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

export function isValidSellDelta(value) {
  return parsePositiveDecimal(value) !== null;
}

export function normalizeSellDelta(value, fallback) {
  const parsed = parsePositiveDecimal(value);
  if (parsed !== null) {
    return formatDollarValue(parsed);
  }
  const fallbackParsed = parsePositiveDecimal(fallback);
  return formatDollarValue(fallbackParsed || Number(DEFAULT_QUICK_PROFIT_DELTA));
}

export function normalizeSellStrategyRules(rules = {}) {
  return {
    quickProfitDelta: normalizeSellDelta(rules?.quickProfitDelta, DEFAULT_QUICK_PROFIT_DELTA)
  };
}

export function calculateSellStrategyLevels(entryPrice, rules = {}) {
  const entry = parsePositiveDecimal(entryPrice);
  if (entry === null) {
    return null;
  }

  const normalizedRules = normalizeSellStrategyRules(rules);
  const quickProfitDelta = Number(normalizedRules.quickProfitDelta);
  return {
    entryPrice: formatDollarValue(entry),
    quickProfitDelta: normalizedRules.quickProfitDelta,
    quickProfitPrice: formatDollarValue(entry + quickProfitDelta)
  };
}

export function buildSellStrategyContext(virtualPosition, rules = {}) {
  return calculateSellStrategyLevels(virtualPosition?.entryPrice, rules);
}
