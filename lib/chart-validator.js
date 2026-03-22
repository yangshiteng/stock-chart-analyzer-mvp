const STOCK_CHART_KEYWORDS = [
  "stock",
  "chart",
  "tradingview",
  "nasdaq",
  "nyse",
  "finance",
  "ticker",
  "candlestick",
  "robinhood",
  "webull",
  "etrade",
  "marketwatch",
  "yahoo finance"
];

function getContextText(pageTitle, pageUrl) {
  return `${pageTitle || ""} ${pageUrl || ""}`.toLowerCase();
}

function guessSymbol(pageTitle, pageUrl) {
  const match = `${pageTitle || ""} ${pageUrl || ""}`.match(/\b[A-Z]{1,5}\b/);
  return match ? match[0] : null;
}

export function validateStockChartByKeywords({ pageTitle, pageUrl }) {
  const context = getContextText(pageTitle, pageUrl);
  const matchedKeywords = STOCK_CHART_KEYWORDS.filter((keyword) => context.includes(keyword));
  const isStockChart = matchedKeywords.length > 0;
  const confidence = Number((isStockChart
    ? Math.min(0.6 + matchedKeywords.length * 0.08, 0.95)
    : 0.12).toFixed(2));

  return {
    validator: "keyword-rule",
    isStockChart,
    confidence,
    matchedKeywords,
    reason: isStockChart
      ? `Keyword validator matched: ${matchedKeywords.join(", ")}.`
      : "Keyword validator found no stock-chart keywords in the page title or URL.",
    symbolGuess: guessSymbol(pageTitle, pageUrl)
  };
}

export { STOCK_CHART_KEYWORDS };
