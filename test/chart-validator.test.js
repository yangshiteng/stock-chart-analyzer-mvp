import { test } from "node:test";
import assert from "node:assert/strict";
import { validateChartTab, TRADINGVIEW_HOSTS } from "../lib/chart-validator.js";

test("chart-validator: accepts tradingview.com", () => {
  const r = validateChartTab({
    pageTitle: "USAR · USA Rare Earth, Inc. Class A · 5 · NASDAQ",
    pageUrl: "https://www.tradingview.com/chart/sfPJCGOU/?symbol=USAR",
    language: "en"
  });
  assert.equal(r.isTradingView, true);
  assert.deepEqual(r.matchedKeywords, ["tradingview"]);
  assert.match(r.reason, /TradingView chart/);
});

test("chart-validator: accepts cn.tradingview.com (Chinese mirror)", () => {
  const r = validateChartTab({
    pageTitle: "USAR · USA Rare Earth",
    pageUrl: "https://cn.tradingview.com/chart/sfPJCGOU/?symbol=USAR",
    language: "zh"
  });
  assert.equal(r.isTradingView, true);
  assert.match(r.reason, /TradingView/);
});

test("chart-validator: rejects non-TradingView platforms", () => {
  const cases = [
    { pageTitle: "TSLA — Yahoo Finance", pageUrl: "https://finance.yahoo.com/quote/TSLA" },
    { pageTitle: "雪球 - TSLA", pageUrl: "https://xueqiu.com/S/TSLA" },
    { pageTitle: "TSLA - 富途", pageUrl: "https://www.futunn.com/stock/TSLA-US" },
    { pageTitle: "Random blog post", pageUrl: "https://example.com/hello" }
  ];
  for (const c of cases) {
    const r = validateChartTab({ ...c, language: "en" });
    assert.equal(r.isTradingView, false, `should reject ${c.pageUrl}`);
    assert.deepEqual(r.matchedKeywords, []);
    assert.match(r.reason, /only supports TradingView/);
  }
});

test("chart-validator: Chinese rejection reason", () => {
  const r = validateChartTab({
    pageTitle: "Yahoo Finance",
    pageUrl: "https://finance.yahoo.com/quote/TSLA",
    language: "zh"
  });
  assert.equal(r.isTradingView, false);
  assert.match(r.reason, /仅支持 TradingView/);
});

test("chart-validator: subdomain of tradingview.com is accepted", () => {
  const r = validateChartTab({
    pageTitle: "TSLA",
    pageUrl: "https://www.tradingview.com/symbols/NASDAQ-TSLA/",
    language: "en"
  });
  assert.equal(r.isTradingView, true);
});

test("chart-validator: no confidence field on return", () => {
  const r = validateChartTab({
    pageTitle: "USAR",
    pageUrl: "https://www.tradingview.com/chart/",
    language: "en"
  });
  assert.equal("confidence" in r, false);
});

test("chart-validator: TRADINGVIEW_HOSTS exported for callers that need to whitelist", () => {
  assert.ok(TRADINGVIEW_HOSTS.includes("tradingview.com"));
  assert.ok(TRADINGVIEW_HOSTS.includes("cn.tradingview.com"));
});
