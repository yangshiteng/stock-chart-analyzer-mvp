const ACTIONABLE_LIMIT_ACTIONS = new Set(["BUY_LIMIT", "SELL_LIMIT"]);

function parseSignalPrice(value) {
  const price = Number(`${value ?? ""}`.trim());
  return Number.isFinite(price) && price > 0 ? price : null;
}

function samePrice(a, b) {
  const pa = parseSignalPrice(a);
  const pb = parseSignalPrice(b);
  if (pa === null || pb === null) {
    return pa === pb;
  }
  return Math.abs(pa - pb) < 0.0001;
}

export function getDiscordNotificationReason(previousAnalysis, currentAnalysis) {
  if (!currentAnalysis?.action) {
    return null;
  }

  if (!previousAnalysis?.action) {
    return "first_signal";
  }

  if (previousAnalysis.action !== currentAnalysis.action) {
    return "action_changed";
  }

  if (
    ACTIONABLE_LIMIT_ACTIONS.has(currentAnalysis.action)
    && !samePrice(previousAnalysis.orderPrice, currentAnalysis.orderPrice)
  ) {
    return "order_price_changed";
  }

  return null;
}
