import { guessSymbol } from "./symbol.js";

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
  "yahoo finance",
  "seeking alpha",
  "investing.com",
  "barchart",
  "stockcharts",
  "finviz",
  // Chinese market / broker platforms
  "雪球",
  "xueqiu",
  "东方财富",
  "eastmoney",
  "富途",
  "futu",
  "moomoo",
  "老虎",
  "tiger",
  "tigerbrokers",
  "长桥",
  "longbridge",
  "longport",
  "同花顺",
  "10jqka",
  "新浪财经",
  "sina finance"
];

function getContextText(pageTitle, pageUrl) {
  return `${pageTitle || ""} ${pageUrl || ""}`.toLowerCase();
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
    "yahoo finance": "雅虎财经",
    "seeking alpha": "Seeking Alpha",
    "investing.com": "英为财情",
    xueqiu: "雪球",
    eastmoney: "东方财富",
    futu: "富途",
    moomoo: "富途牛牛",
    tiger: "老虎证券",
    tigerbrokers: "老虎证券",
    longbridge: "长桥",
    longport: "长桥",
    "10jqka": "同花顺",
    "sina finance": "新浪财经"
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
  const matchedKeywords = STOCK_CHART_KEYWORDS.filter((keyword) => context.includes(keyword.toLowerCase()));
  const localizedKeywords = matchedKeywords.map((keyword) => localizeKeyword(keyword, language));
  const isStockChart = matchedKeywords.length > 0;

  return {
    validator: "keyword-rule",
    isStockChart,
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
