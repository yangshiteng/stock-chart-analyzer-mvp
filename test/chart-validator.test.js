import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStockChartByKeywordsWithLanguage } from "../lib/chart-validator.js";

test("chart-validator: English match on page title", () => {
  const r = validateStockChartByKeywordsWithLanguage({
    pageTitle: "TSLA Stock Chart - TradingView",
    pageUrl: "https://tradingview.com/chart",
    language: "en"
  });
  assert.equal(r.isStockChart, true);
  assert.ok(r.matchedKeywords.includes("stock"));
  assert.match(r.reason, /Keyword validator matched/);
});

test("chart-validator: Chinese localized reason", () => {
  const r = validateStockChartByKeywordsWithLanguage({
    pageTitle: "雪球 - TSLA",
    pageUrl: "https://xueqiu.com/S/TSLA",
    language: "zh"
  });
  assert.equal(r.isStockChart, true);
  assert.match(r.reason, /关键词校验器命中/);
});

test("chart-validator: negative match returns false", () => {
  const r = validateStockChartByKeywordsWithLanguage({
    pageTitle: "Random blog post",
    pageUrl: "https://example.com/hello",
    language: "en"
  });
  assert.equal(r.isStockChart, false);
  assert.deepEqual(r.matchedKeywords, []);
});

test("chart-validator: no confidence field on return", () => {
  const r = validateStockChartByKeywordsWithLanguage({
    pageTitle: "TSLA Stock",
    pageUrl: "",
    language: "en"
  });
  assert.equal("confidence" in r, false);
});
