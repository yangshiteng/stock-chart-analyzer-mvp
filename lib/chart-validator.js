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

function localizeKeyword(keyword, language) {
  if (language !== "zh") {
    return keyword;
  }

  const mapping = {
    stock: "股票",
    chart: "图表",
    finance: "金融",
    ticker: "代码",
    candlestick: "K线",
    "yahoo finance": "雅虎财经"
  };

  return mapping[keyword] || keyword;
}

export function validateStockChartByKeywords({ pageTitle, pageUrl }) {
  return validateStockChartByKeywordsWithLanguage({
    pageTitle,
    pageUrl,
    language: "en"
  });
}

export function validateStockChartByKeywordsWithLanguage({ pageTitle, pageUrl, language = "en" }) {
  const context = getContextText(pageTitle, pageUrl);
  const matchedKeywords = STOCK_CHART_KEYWORDS.filter((keyword) => context.includes(keyword));
  const localizedKeywords = matchedKeywords.map((keyword) => localizeKeyword(keyword, language));
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
      ? language === "zh"
        ? `关键词校验器命中：${localizedKeywords.join("、")}。`
        : `Keyword validator matched: ${matchedKeywords.join(", ")}.`
      : language === "zh"
        ? "关键词校验器没有在页面标题或 URL 中找到股票图表相关关键词。"
        : "Keyword validator found no stock-chart keywords in the page title or URL.",
    symbolGuess: guessSymbol(pageTitle, pageUrl)
  };
}

export { STOCK_CHART_KEYWORDS };
