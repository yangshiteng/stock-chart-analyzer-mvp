import { guessSymbol } from "./symbol.js";

// The extension is intentionally locked to TradingView. Rationale:
// - Single platform = predictable chart layout, indicator labels, and color scheme,
//   which keeps the screenshot-based prompt stable across users.
// - Users get one-click setup via a shared TradingView layout (see README).
// - Validator becomes a hostname check instead of a fragile multi-platform keyword list.
//
// If you ever consider relaxing this back to multi-platform, remember it was an explicit
// product decision — the prompt assumes the TradingView legend / right-axis conventions,
// and other platforms degrade signal quality without a way to detect or warn the user.
const TRADINGVIEW_HOSTS = ["tradingview.com", "cn.tradingview.com"];

function getHostname(pageUrl) {
  if (!pageUrl) return "";
  try {
    return new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isTradingViewHost(hostname) {
  if (!hostname) return false;
  return TRADINGVIEW_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

export function validateChartTab({ pageTitle, pageUrl, language = "en" }) {
  const hostname = getHostname(pageUrl);
  const isTradingView = isTradingViewHost(hostname);

  return {
    validator: "tradingview-host",
    isTradingView,
    matchedKeywords: isTradingView ? ["tradingview"] : [],
    reason: isTradingView
      ? language === "zh"
        ? "已确认当前标签页是 TradingView 图表。"
        : "Current tab confirmed as a TradingView chart."
      : language === "zh"
        ? "当前标签页不是 TradingView。本扩展仅支持 TradingView 图表。"
        : "Current tab is not TradingView. This extension only supports TradingView charts.",
    symbolGuess: guessSymbol(pageTitle, pageUrl)
  };
}

export { TRADINGVIEW_HOSTS };
