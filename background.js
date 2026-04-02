import {
  ALARM_MINUTES,
  ALARM_NAME,
  AUTO_STOP_OPTIONS,
  MAX_RESULTS,
  RISK_STYLE_OPTIONS,
  STATUS,
  createDefaultState
} from "./lib/constants.js";
import { validateStockChartByKeywordsWithLanguage } from "./lib/chart-validator.js";
import { getLanguage } from "./lib/i18n.js";
import { analyzeChartCapture } from "./lib/llm.js";
import { getSettings, getState, patchState, saveState } from "./lib/storage.js";

const ICON_PATH = "assets/icon-128.png";
const SIDEPANEL_PATH = "sidepanel.html";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const VALID_RISK_STYLES = new Set(RISK_STYLE_OPTIONS.map((option) => option.value));
const AUTO_STOP_MINUTES = new Map(AUTO_STOP_OPTIONS.map((option) => [option.value, option.minutes]));
const VALID_AUTO_STOP_RULES = new Set(AUTO_STOP_OPTIONS.map((option) => option.value));
let creatingOffscreenDocument = null;

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function notifyUser(title, message) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: ICON_PATH,
      title,
      message
    });
  } catch (error) {
    console.warn("Notification failed:", error);
  }
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    return false;
  }

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return true;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play a short sound when a new chart recommendation is ready."
  }).catch((error) => {
    const message = `${error?.message || error}`;

    if (!message.includes("Only a single offscreen")) {
      throw error;
    }
  }).finally(() => {
    creatingOffscreenDocument = null;
  });

  await creatingOffscreenDocument;
  return true;
}

async function playResultSound() {
  try {
    const ready = await ensureOffscreenDocument();

    if (!ready) {
      return;
    }

    await chrome.runtime.sendMessage({
      type: "play-result-sound"
    });
  } catch (error) {
    console.warn("Result sound failed:", error);
  }
}

function isValidDiscordWebhookUrl(value) {
  try {
    const url = new URL(value);
    const validHosts = new Set(["discord.com", "canary.discord.com", "ptb.discord.com", "discordapp.com"]);

    return url.protocol === "https:" && validHosts.has(url.hostname) && url.pathname.startsWith("/api/webhooks/");
  } catch {
    return false;
  }
}

function truncateText(value, maxLength = 280) {
  if (!value) {
    return "";
  }

  const text = `${value}`.trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function getDiscordFallback(language) {
  return language === "zh" ? "无" : "N/A";
}

function getDiscordActionLabel(language, action) {
  const labels = {
    OPEN: language === "zh" ? "开仓" : "Open",
    ADD: language === "zh" ? "加仓" : "Add",
    HOLD: language === "zh" ? "持有" : "Hold",
    REDUCE: language === "zh" ? "减仓" : "Reduce",
    EXIT: language === "zh" ? "退出" : "Exit",
    WAIT: language === "zh" ? "等待" : "Wait"
  };

  return labels[action] || (language === "zh" ? "未知" : "Unknown");
}

function getDiscordClarityLabel(language, confidence) {
  const value = Number(confidence);

  if (!Number.isFinite(value)) {
    return language === "zh" ? "未知" : "Unknown";
  }

  if (value < 35) {
    return language === "zh" ? "低" : "Low";
  }

  if (value < 70) {
    return language === "zh" ? "中" : "Medium";
  }

  return language === "zh" ? "高" : "High";
}

function getDiscordColor(action) {
  if (action === "OPEN" || action === "ADD") {
    return 0x1f8f4e;
  }

  if (action === "REDUCE" || action === "EXIT") {
    return 0xb64a3a;
  }

  if (action === "WAIT") {
    return 0xa57008;
  }

  return 0x4f718c;
}

function getDiscordRiskStyleLabel(language, riskStyle) {
  if (riskStyle === "conservative") {
    return language === "zh" ? "保守" : "Conservative";
  }

  if (riskStyle === "moderate") {
    return language === "zh" ? "中性" : "Moderate";
  }

  if (riskStyle === "aggressive") {
    return language === "zh" ? "激进" : "Aggressive";
  }

  return getDiscordFallback(language);
}

function getDiscordOrderLabel(language, analysis) {
  if (analysis.orderType === "LIMIT" && analysis.limitPrice && analysis.limitPrice !== "N/A") {
    return language === "zh" ? `限价 ${analysis.limitPrice}` : `LIMIT at ${analysis.limitPrice}`;
  }

  return language === "zh" ? "现在不下单" : "No order now";
}

function getDiscordPositionSummary(language, monitoringProfile) {
  const positionContext = monitoringProfile?.positionContext;

  if (!positionContext || positionContext.currentShares === undefined || positionContext.currentShares === null) {
    return getDiscordFallback(language);
  }

  const shares = positionContext.currentShares;
  const averageCost = positionContext.averageCost ?? getDiscordFallback(language);

  return language === "zh"
    ? `${shares} 股，成本 ${averageCost}`
    : `${shares} shares at ${averageCost}`;
}

function buildDiscordAnalysisPayload(result, state, language) {
  const analysis = result?.analysis || {};
  const levels = analysis.levels || {};
  const fallback = getDiscordFallback(language);
  const symbol = analysis.symbol || result?.validation?.symbolGuess || fallback;
  const description = truncateText(
    analysis.summary || (language === "zh" ? "新的图表分析结果已生成。" : "A new chart analysis result is ready."),
    350
  );
  const hiddenFieldValue = "__discord_hidden_pending_order__";

  const payload = {
    username: language === "zh" ? "股票图表分析器" : "Stock Chart Analyzer",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: language === "zh" ? `最新建议 - ${symbol}` : `Latest Recommendation - ${symbol}`,
        url: result?.pageUrl || undefined,
        description,
        color: getDiscordColor(analysis.action),
        fields: [
          {
            name: language === "zh" ? "当前动作" : "Action Now",
            value: truncateText(getDiscordActionLabel(language, analysis.action), 100),
            inline: true
          },
          {
            name: language === "zh" ? "挂单计划" : "Order Plan",
            value: truncateText(getDiscordOrderLabel(language, analysis), 120),
            inline: true
          },
          {
            name: language === "zh" ? "信号清晰度" : "Signal Clarity",
            value: truncateText(getDiscordClarityLabel(language, analysis.confidence), 120),
            inline: true
          },
          {
            name: language === "zh" ? "关注价位" : "Watch Level",
            value: truncateText(levels.entry || analysis.limitPrice || fallback, 250),
            inline: true
          },
          {
            name: language === "zh" ? "目标位" : "Target",
            value: truncateText(levels.target || fallback, 250),
            inline: true
          }
        ],
        footer: {
          text: language === "zh"
            ? `第 ${result?.round || state?.roundCount || 0} 轮`
            : `Round ${result?.round || state?.roundCount || 0}`
        },
        timestamp: result?.capturedAt || new Date().toISOString()
      }
    ]
  };
  payload.embeds[0].fields = payload.embeds[0].fields.filter((field) => field.value !== hiddenFieldValue);
  return payload;
}

function getDiscordFallbackV2(language) {
  return language === "zh" ? "无" : "N/A";
}

function getDiscordActionLabelV2(language, action) {
  const labels = {
    OPEN: language === "zh" ? "开仓" : "Open",
    ADD: language === "zh" ? "加仓" : "Add",
    HOLD: language === "zh" ? "持有" : "Hold",
    REDUCE: language === "zh" ? "减仓" : "Reduce",
    EXIT: language === "zh" ? "退出" : "Exit",
    WAIT: language === "zh" ? "等待" : "Wait"
  };

  return labels[action] || (language === "zh" ? "未知" : "Unknown");
}

function getDiscordClarityLabelV2(language, confidence) {
  const value = Number(confidence);

  if (!Number.isFinite(value)) {
    return language === "zh" ? "未知" : "Unknown";
  }

  if (value < 35) {
    return language === "zh" ? "低" : "Low";
  }

  if (value < 70) {
    return language === "zh" ? "中" : "Medium";
  }

  return language === "zh" ? "高" : "High";
}

function getDiscordRiskStyleLabelV2(language, riskStyle) {
  if (riskStyle === "conservative") {
    return language === "zh" ? "保守" : "Conservative";
  }

  if (riskStyle === "moderate") {
    return language === "zh" ? "中性" : "Moderate";
  }

  if (riskStyle === "aggressive") {
    return language === "zh" ? "激进" : "Aggressive";
  }

  return getDiscordFallbackV2(language);
}

function getDiscordBooleanLabelV2(language, value) {
  return language === "zh" ? (value ? "是" : "否") : (value ? "Yes" : "No");
}

function getDiscordOrderLabelV2(language, analysis) {
  if (analysis.orderType === "LIMIT" && analysis.limitPrice && analysis.limitPrice !== "N/A") {
    return language === "zh" ? `限价 ${analysis.limitPrice}` : `LIMIT at ${analysis.limitPrice}`;
  }

  return language === "zh" ? "现在不下单" : "No order now";
}

function getDiscordCurrentPriceLabel(language, analysis) {
  return truncateText(analysis.currentPrice || getDiscordFallbackV2(language), 120);
}

function getDiscordPendingOrderSummary(language, pendingOrders, side) {
  const isBuy = side === "buy";
  const price = isBuy ? pendingOrders?.limitBuyPrice : pendingOrders?.limitSellPrice;
  const shares = Number(isBuy ? pendingOrders?.limitBuyShares ?? 0 : pendingOrders?.limitSellShares ?? 0);

  if (shares > 0 && price !== null && price !== undefined && price !== "") {
    return language === "zh" ? `${shares} 股 @ ${price}` : `${shares} shares @ ${price}`;
  }

  return language === "zh" ? "当前没有挂单" : "No active order";
}

function getDiscordSuggestedGuidanceSummary(language, guidance) {
  const price = guidance?.price || getDiscordFallbackV2(language);
  const shares = guidance?.shares || getDiscordFallbackV2(language);
  const reason = guidance?.reason || getDiscordFallbackV2(language);

  return truncateText(
    language === "zh"
      ? `状态：仅供参考\n价格：${price}\n股数：${shares}\n原因：${reason}`
      : `Status: Reference\nPrice: ${price}\nShares: ${shares}\nReason: ${reason}`,
    500
  );
}

function getDiscordReferenceGuidanceSummary(language, guidance) {
  const price = guidance?.price || getDiscordFallbackV2(language);
  const shares = guidance?.shares || getDiscordFallbackV2(language);
  const reason = guidance?.reason || getDiscordFallbackV2(language);

  return truncateText(
    language === "zh"
      ? `价格：${price}\n股数：${shares}\n原因：${reason}`
      : `Price: ${price}\nShares: ${shares}\nReason: ${reason}`,
    500
  );
}

function getDiscordPositionSummaryV2(language, monitoringProfile) {
  const positionContext = monitoringProfile?.positionContext;

  if (!positionContext || positionContext.currentShares === undefined || positionContext.currentShares === null) {
    return getDiscordFallbackV2(language);
  }

  const shares = positionContext.currentShares;
  const averageCost = positionContext.averageCost ?? getDiscordFallbackV2(language);

  return language === "zh"
    ? `${shares} 股，成本 ${averageCost}`
    : `${shares} shares at ${averageCost}`;
}

function buildDiscordAnalysisPayloadV2(result, state, language) {
  const analysis = result?.analysis || {};
  const levels = analysis.levels || {};
  const fallback = getDiscordFallbackV2(language);
  const symbol = analysis.symbol || result?.validation?.symbolGuess || fallback;
  const monitoringProfile = result?.monitoringProfile || state?.monitoringProfile || state?.lastMonitoringProfile;
  const description = truncateText(
    analysis.summary || (language === "zh" ? "新的图表分析结果已经生成。" : "A new chart analysis result is ready."),
    350
  );
  const hiddenFieldValue = "__discord_hidden_pending_order__";

  const payload = {
    username: language === "zh" ? "股票图表分析器" : "Stock Chart Analyzer",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: language === "zh" ? `最新建议 - ${symbol}` : `Latest Recommendation - ${symbol}`,
        url: result?.pageUrl || undefined,
        description,
        color: getDiscordColor(analysis.action),
        fields: [
          {
            name: language === "zh" ? "现在价格" : "Current Price",
            value: getDiscordCurrentPriceLabel(language, analysis),
            inline: true
          },
          {
            name: language === "zh" ? "当前动作" : "Action Now",
            value: truncateText(getDiscordActionLabelV2(language, analysis.action), 100),
            inline: true
          },
          {
            name: language === "zh" ? "挂单计划" : "Order Plan",
            value: truncateText(getDiscordOrderLabelV2(language, analysis), 120),
            inline: true
          },
          {
            name: language === "zh" ? "信号清晰度" : "Signal Clarity",
            value: truncateText(getDiscordClarityLabelV2(language, analysis.confidence), 120),
            inline: true
          },
          {
            name: language === "zh" ? "关注价位" : "Watch Level",
            value: truncateText(levels.entry || analysis.limitPrice || fallback, 250),
            inline: true
          },
          {
            name: language === "zh" ? "目标位" : "Target",
            value: truncateText(levels.target || fallback, 250),
            inline: true
          },
          {
            name: language === "zh" ? "风险触发位" : "Risk Trigger",
            value: truncateText(levels.invalidation || fallback, 250),
            inline: true
          },
          {
            name: language === "zh" ? "建议仓位" : "Suggested Size",
            value: truncateText(analysis.sizeSuggestion || fallback, 250),
            inline: true
          },
          {
            name: language === "zh" ? "当前挂买单" : "Current Limit Buy Order",
            value: hiddenFieldValue,
            inline: true
          },
          {
            name: language === "zh" ? "当前挂卖单" : "Current Limit Sell Order",
            value: hiddenFieldValue,
            inline: true
          },
          {
            name: language === "zh" ? "周期" : "Timeframe",
            value: truncateText(analysis.timeframe || fallback, 120),
            inline: true
          },
          {
            name: language === "zh" ? "持仓" : "Position",
            value: truncateText(getDiscordPositionSummaryV2(language, monitoringProfile), 220),
            inline: false
          },
          {
            name: language === "zh" ? "可用资金" : "Available Cash",
            value: truncateText(`${monitoringProfile?.capitalContext?.availableCash ?? fallback}`, 220),
            inline: false
          },
          {
            name: language === "zh" ? "风险规则" : "Risk Rules",
            value: truncateText(
              language === "zh"
                ? `允许摊低成本：${getDiscordBooleanLabelV2(language, monitoringProfile?.rules?.allowAveragingDown)}，允许卖出类动作：${getDiscordBooleanLabelV2(language, monitoringProfile?.rules?.allowReducingPosition)}，风格：${getDiscordRiskStyleLabelV2(language, monitoringProfile?.rules?.riskStyle)}`
                : `Average down: ${getDiscordBooleanLabelV2(language, monitoringProfile?.rules?.allowAveragingDown)}, Sell-side actions: ${getDiscordBooleanLabelV2(language, monitoringProfile?.rules?.allowReducingPosition)}, Style: ${getDiscordRiskStyleLabelV2(language, monitoringProfile?.rules?.riskStyle)}`,
              280
            ),
            inline: false
          },
          {
            name: language === "zh" ? "买单指导" : "Limit Buy Guidance",
            value: getDiscordReferenceGuidanceSummary(language, analysis.buyOrderGuidance),
            inline: false
          },
          {
            name: language === "zh" ? "卖单指导" : "Limit Sell Guidance",
            value: getDiscordReferenceGuidanceSummary(language, analysis.sellOrderGuidance),
            inline: false
          }
        ],
        footer: {
          text: language === "zh"
            ? `第 ${result?.round || state?.roundCount || 0} 轮`
            : `Round ${result?.round || state?.roundCount || 0}`
        },
        timestamp: result?.capturedAt || new Date().toISOString()
      }
    ]
  };
  payload.embeds[0].fields = payload.embeds[0].fields.filter((field) => field.value !== hiddenFieldValue);
  return payload;
}

function buildDiscordAnalysisPayloadV3(result, state, language) {
  const analysis = result?.analysis || {};
  const levels = analysis.levels || {};
  const fallback = getDiscordFallbackV2(language);
  const symbol = analysis.symbol || result?.validation?.symbolGuess || fallback;
  const description = truncateText(
    analysis.whatToDoNow || analysis.summary || (language === "zh" ? "新的图表分析结果已经生成。" : "A new chart analysis result is ready."),
    350
  );

  return {
    username: language === "zh" ? "股票图表分析器" : "Stock Chart Analyzer",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: language === "zh" ? `最新建议 - ${symbol}` : `Latest Recommendation - ${symbol}`,
        url: result?.pageUrl || undefined,
        description,
        color: getDiscordColor(analysis.action),
        fields: [
          {
            name: language === "zh" ? "当前动作" : "Action Now",
            value: truncateText(getDiscordActionLabelV2(language, analysis.action), 100),
            inline: true
          },
          {
            name: language === "zh" ? "挂单计划" : "Order Plan",
            value: truncateText(getDiscordOrderLabelV2(language, analysis), 120),
            inline: true
          },
          {
            name: language === "zh" ? "现在价格" : "Current Price",
            value: getDiscordCurrentPriceLabel(language, analysis),
            inline: true
          },
          {
            name: language === "zh" ? "当前支撑位" : "Current Support",
            value: truncateText(analysis.supportLevels || levels.entry || fallback, 250),
            inline: true
          },
          {
            name: language === "zh" ? "当前压力位" : "Current Resistance",
            value: truncateText(analysis.resistanceLevels || levels.target || fallback, 250),
            inline: true
          },
          {
            name: language === "zh" ? "如果跌到这里要小心" : "Caution Price",
            value: truncateText(levels.invalidation || fallback, 250),
            inline: true
          },
          {
            name: language === "zh" ? "建议仓位" : "Suggested Size",
            value: truncateText(analysis.sizeSuggestion || fallback, 250),
            inline: true
          },
          {
            name: language === "zh" ? "买入参考" : "Buy Reference",
            value: getDiscordReferenceGuidanceSummary(language, analysis.buyOrderGuidance),
            inline: false
          },
          {
            name: language === "zh" ? "卖出参考" : "Sell Reference",
            value: getDiscordReferenceGuidanceSummary(language, analysis.sellOrderGuidance),
            inline: false
          },
          {
            name: language === "zh" ? "需要注意" : "Watch Out",
            value: truncateText(analysis.riskNote || fallback, 300),
            inline: false
          }
        ],
        footer: {
          text: language === "zh"
            ? `第 ${result?.round || state?.roundCount || 0} 轮`
            : `Round ${result?.round || state?.roundCount || 0}`
        },
        timestamp: result?.capturedAt || new Date().toISOString()
      }
    ]
  };
}

async function notifyDiscordAnalysisResult(result, state, language) {
  const settings = await getSettings();
  const webhookUrl = settings.discordWebhookUrl?.trim();

  if (!webhookUrl || !isValidDiscordWebhookUrl(webhookUrl)) {
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildDiscordAnalysisPayloadV3(result, state, language))
    });

    if (!response.ok) {
      throw new Error(`Discord webhook returned ${response.status}`);
    }
  } catch (error) {
    console.warn("Discord notification failed:", error);
  }
}

async function clearMonitoringAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
}

async function getUiLanguage() {
  const settings = await getSettings();
  return getLanguage(settings.language);
}

function bgText(language, key, vars = {}) {
  const dict = {
    en: {
      noActiveTab: "No active tab was found. Focus a chart tab and try again.",
      untitledTab: "Untitled tab",
      saveApiKeyFirst: "Save your OpenAI API key before starting monitoring.",
      mustBeNumber: "{label} must be a number.",
      currentSharesLabel: "Current shares",
      averageCostLabel: "Average cost",
      availableCashLabel: "Available cash",
      currentSharesMin: "Current shares must be 0 or greater.",
      averageCostMin: "Average cost must be greater than 0.",
      availableCashMin: "Available cash must be 0 or greater.",
      averageCostRequired: "Average cost is required when you already hold shares.",
      chooseValidRiskStyle: "Choose a valid risk style.",
      chooseValidAutoStop: "Choose a valid auto stop option.",
      validationFailedChart: "Validation failed because the current tab does not look like a stock chart.",
      notifyChartNotDetectedTitle: "Stock chart not detected",
      notifyChartNotDetectedBody: "Monitoring stopped because the current tab is not recognized as a stock chart.",
      validationFailedCapture: "Validation failed because the tab could not be captured.",
      notifyCaptureFailed: "Capture failed",
      fillFormFirst: "Fill in the execution constraints form before starting monitoring.",
      reachedRounds: "Reached {maxRounds} rounds.",
      monitoringStoppedChart: "Monitoring stopped because the current tab is no longer recognized as a stock chart.",
      notifyMonitoringStopped: "Monitoring stopped",
      notifyCurrentTabNotChart: "The current tab is no longer recognized as a stock chart.",
      notifyMonitoringFinished: "Monitoring finished",
      notifyStoppedAfterRounds: "Stopped after {maxRounds} rounds.",
      monitoringStoppedAnalyze: "Monitoring stopped because the current tab could not be analyzed.",
      stoppedByUser: "Monitoring paused by the user.",
      noPreviousSession: "No previous monitoring session is available yet."
    },
    zh: {
      noActiveTab: "没有找到当前活动标签页。请先聚焦到图表页面后再试。",
      untitledTab: "未命名标签页",
      saveApiKeyFirst: "开始监控前请先保存 OpenAI 密钥。",
      mustBeNumber: "{label} 必须是数字。",
      currentSharesLabel: "当前持股数",
      averageCostLabel: "平均成本",
      availableCashLabel: "可用资金",
      currentSharesMin: "当前持股数必须大于或等于 0。",
      averageCostMin: "平均成本必须大于 0。",
      availableCashMin: "可用资金必须大于或等于 0。",
      averageCostRequired: "如果你已经持有股票，就必须填写平均成本。",
      chooseValidRiskStyle: "请选择有效的风险风格。",
      validationFailedChart: "校验失败，因为当前标签页看起来不像股票图。",
      notifyChartNotDetectedTitle: "未识别到股票图表",
      notifyChartNotDetectedBody: "监控已停止，因为当前标签页未被识别为股票图表。",
      validationFailedCapture: "校验失败，因为当前标签页无法被截取。",
      notifyCaptureFailed: "截图失败",
      fillFormFirst: "开始监控前请先填写执行约束表单。",
      reachedRounds: "已达到 {maxRounds} 轮。",
      monitoringStoppedChart: "监控已停止，因为当前标签页不再被识别为股票图表。",
      notifyMonitoringStopped: "监控已停止",
      notifyCurrentTabNotChart: "当前标签页不再被识别为股票图表。",
      notifyMonitoringFinished: "监控已完成",
      notifyStoppedAfterRounds: "已在 {maxRounds} 轮后停止。",
      monitoringStoppedAnalyze: "监控已停止，因为当前标签页无法完成分析。",
      stoppedByUser: "监控已由用户手动暂停。",
      noPreviousSession: "目前还没有可继续的历史监控会话。"
    }
  };

  const locale = language === "zh" ? dict.zh : dict.en;
  const template = locale[key] || dict.en[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) => `${vars[name] ?? ""}`);
}

function scheduleMonitoringAlarm() {
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: ALARM_MINUTES,
    periodInMinutes: ALARM_MINUTES
  });
}

async function getActiveTab(windowId = null) {
  const language = await getUiLanguage();
  const query = { active: true };

  if (windowId) {
    query.windowId = windowId;
  } else {
    query.lastFocusedWindow = true;
  }

  const [tab] = await chrome.tabs.query(query);

  if (!tab?.windowId) {
    throw new Error(bgText(language, "noActiveTab"));
  }

  return tab;
}

async function captureActiveTab(windowId = null) {
  const tab = await getActiveTab(windowId);
  const imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png"
  });

  return {
    tabId: tab.id ?? null,
    windowId: tab.windowId,
    pageTitle: tab.title || bgText(await getUiLanguage(), "untitledTab"),
    pageUrl: tab.url || "",
    imageDataUrl
  };
}

function buildValidationRecord(validation, capture) {
  return {
    ...validation,
    tabId: capture.tabId,
    windowId: capture.windowId,
    pageTitle: capture.pageTitle,
    pageUrl: capture.pageUrl,
    checkedAt: new Date().toISOString()
  };
}

function bindMonitoringProfileToTab(monitoringProfile, tab) {
  return {
    ...monitoringProfile,
    boundTabId: tab.id ?? null,
    boundWindowId: tab.windowId ?? null,
    boundTabTitle: tab.title || "",
    boundTabUrl: tab.url || ""
  };
}

function getPauseReason(language) {
  return language === "zh"
    ? "你已离开原始图表标签页，监控已自动暂停。返回该标签页后可继续。"
    : "Monitoring paused because you left the original chart tab. Return to that tab to continue.";
}

function getClosedTabReason(language) {
  return language === "zh"
    ? "原始图表标签页已关闭，监控已停止。"
    : "Monitoring stopped because the original chart tab was closed.";
}

function getUserPauseReason(language) {
  return language === "zh"
    ? "监控已由用户手动暂停。"
    : "Monitoring paused by the user.";
}

function getResumeTabMismatchReason(language) {
  return language === "zh"
    ? "请先返回原始图表标签页，再继续监控。"
    : "Return to the original chart tab before continuing monitoring.";
}

function getResumeTabMissingReason(language) {
  return language === "zh"
    ? "原始图表标签页已不存在，请重新开始。"
    : "The original chart tab is no longer available. Start again from the chart tab.";
}

async function getTabById(tabId) {
  if (!tabId) {
    return null;
  }

  return chrome.tabs.get(tabId).catch(() => null);
}

function getSessionTabIds(state) {
  return Array.from(new Set([
    state.monitoringProfile?.boundTabId,
    state.lastMonitoringProfile?.boundTabId,
    state.lastValidation?.tabId
  ].filter(Boolean)));
}

async function pauseMonitoring(reason, currentState = null) {
  await clearMonitoringAlarm();

  const state = currentState || await getState();
  const monitoringProfile = state.monitoringProfile || state.lastMonitoringProfile;
  const boundTabId = monitoringProfile?.boundTabId || state.lastValidation?.tabId || null;

  const nextState = await patchState({
    status: STATUS.PAUSED,
    isRoundInFlight: false,
    monitoringProfile,
    lastMonitoringProfile: monitoringProfile,
    stopReason: reason,
    lastError: null
  });

  if (boundTabId) {
    await chrome.sidePanel.setOptions({
      tabId: boundTabId,
      path: SIDEPANEL_PATH,
      enabled: true
    }).catch(() => {});
  }

  return nextState;
}

async function ensureMonitoringTabActive(monitoringProfile, language) {
  const boundTab = await getTabById(monitoringProfile?.boundTabId);

  if (!boundTab) {
    throw new Error(getResumeTabMissingReason(language));
  }

  const activeTab = await getActiveTab(monitoringProfile?.boundWindowId || null);

  if (activeTab.id !== boundTab.id) {
    throw new Error(getResumeTabMismatchReason(language));
  }

  return boundTab;
}

function shouldEnableSidePanelForTab(state, tabId, validation) {
  if (!validation.isStockChart) {
    return false;
  }

  if (state.status === STATUS.AWAITING_CONTEXT) {
    return state.lastValidation?.tabId === tabId;
  }

  if (state.status === STATUS.RUNNING || state.status === STATUS.PAUSED) {
    const monitoringProfile = state.monitoringProfile || state.lastMonitoringProfile;
    return monitoringProfile?.boundTabId === tabId;
  }

  return false;
}

async function setSidePanelAvailabilityForTab(tabId, tab = null) {
  if (!tabId) {
    return false;
  }

  const language = await getUiLanguage();
  const state = await getState();
  const targetTab = tab || await chrome.tabs.get(tabId).catch(() => null);

  if (!targetTab) {
    return false;
  }

  const validation = validateStockChartByKeywordsWithLanguage({
    pageTitle: targetTab.title || "",
    pageUrl: targetTab.url || "",
    language
  });

  if (shouldEnableSidePanelForTab(state, tabId, validation)) {
    await chrome.sidePanel.setOptions({
      tabId,
      path: SIDEPANEL_PATH,
      enabled: true
    });

    return true;
  }

  await chrome.sidePanel.setOptions({
    tabId,
    enabled: false
  });

  if (targetTab.windowId) {
    await chrome.sidePanel.close({
      windowId: targetTab.windowId
    }).catch(() => {});
  }

  return false;
}

async function ensureApiKeyConfigured() {
  const settings = await getSettings();

  if (!settings.openaiApiKey) {
    throw new Error(bgText(getLanguage(settings.language), "saveApiKeyFirst"));
  }
}

function normalizeDecimal(value, label, language) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(bgText(language, "mustBeNumber", { label }));
  }

  return Number(parsed.toFixed(4));
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === "yes" || value === 1 || value === "1";
}

function normalizeOptionalDecimal(value, label, language) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  return normalizeDecimal(value, label, language);
}

function getPendingOrderFieldLabels(language) {
  return {
    limitBuyPrice: language === "zh" ? "当前挂买单价格" : "Current limit buy price",
    limitBuyShares: language === "zh" ? "当前挂买单股数" : "Current limit buy shares",
    limitSellPrice: language === "zh" ? "当前挂卖单价格" : "Current limit sell price",
    limitSellShares: language === "zh" ? "当前挂卖单股数" : "Current limit sell shares"
  };
}

function getAutoStopMinutes(rule) {
  return AUTO_STOP_MINUTES.get(rule) ?? null;
}

function normalizeAutoStopRule(rule) {
  return VALID_AUTO_STOP_RULES.has(rule) ? rule : "30m";
}

function refreshAutoStopDeadline(monitoringProfile) {
  const autoStopRule = normalizeAutoStopRule(monitoringProfile?.rules?.autoStopRule);
  const minutes = getAutoStopMinutes(autoStopRule);

  return {
    ...monitoringProfile,
    rules: {
      ...monitoringProfile?.rules,
      autoStopRule
    },
    autoStopAt: minutes ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : null
  };
}

function getAutoStopLabel(language, rule) {
  const normalizedRule = normalizeAutoStopRule(rule);
  const labels = {
    off: language === "zh" ? "不自动停止" : "off",
    "30m": language === "zh" ? "30 分钟后" : "30 minutes",
    "1h": language === "zh" ? "1 小时后" : "1 hour",
    "2h": language === "zh" ? "2 小时后" : "2 hours",
    "4h": language === "zh" ? "4 小时后" : "4 hours"
  };

  if (normalizedRule === "8h") {
    return language === "zh" ? "8 小时后" : "8 hours";
  }

  return labels[normalizedRule] || labels["30m"];
}

function getAutoStopReason(language, rule) {
  const label = getAutoStopLabel(language, rule);

  return language === "zh"
    ? `已到自动停止时间（${label}），监控已自动暂停。`
    : `Monitoring paused automatically after ${label}.`;
}

async function buildMonitoringProfile(payload) {
  const language = await getUiLanguage();
  const pendingOrderLabels = getPendingOrderFieldLabels(language);
  const currentShares = normalizeDecimal(payload.currentShares, bgText(language, "currentSharesLabel"), language);

  if (currentShares < 0) {
    throw new Error(bgText(language, "currentSharesMin"));
  }

  const averageCost = payload.averageCost === "" || payload.averageCost === null || payload.averageCost === undefined
    ? null
    : normalizeDecimal(payload.averageCost, bgText(language, "averageCostLabel"), language);

  if (averageCost !== null && averageCost <= 0) {
    throw new Error(bgText(language, "averageCostMin"));
  }

  if (currentShares > 0 && averageCost === null) {
    throw new Error(bgText(language, "averageCostRequired"));
  }

  const availableCash = normalizeDecimal(payload.availableCash, bgText(language, "availableCashLabel"), language);

  if (availableCash < 0) {
    throw new Error(bgText(language, "availableCashMin"));
  }

  const limitBuyPrice = normalizeOptionalDecimal(payload.limitBuyPrice, pendingOrderLabels.limitBuyPrice, language);
  const limitBuyShares = payload.limitBuyShares === "" || payload.limitBuyShares === null || payload.limitBuyShares === undefined
    ? 0
    : normalizeDecimal(payload.limitBuyShares, pendingOrderLabels.limitBuyShares, language);

  if (limitBuyPrice !== null && limitBuyPrice <= 0) {
    throw new Error(language === "zh" ? "当前挂买单价格必须大于 0。" : "Current limit buy price must be greater than 0.");
  }

  if (limitBuyShares < 0) {
    throw new Error(language === "zh" ? "当前挂买单股数必须大于或等于 0。" : "Current limit buy shares must be 0 or greater.");
  }

  if (limitBuyShares > 0 && limitBuyPrice === null) {
    throw new Error(language === "zh" ? "如果已经挂了买单股数，就必须填写挂买单价格。" : "Current limit buy price is required when limit buy shares are greater than 0.");
  }

  if (limitBuyPrice !== null && limitBuyShares <= 0) {
    throw new Error(language === "zh" ? "如果已经填写挂买单价格，就必须填写挂买单股数。" : "Current limit buy shares are required when a limit buy price is set.");
  }

  const limitSellPrice = normalizeOptionalDecimal(payload.limitSellPrice, pendingOrderLabels.limitSellPrice, language);
  const limitSellShares = payload.limitSellShares === "" || payload.limitSellShares === null || payload.limitSellShares === undefined
    ? 0
    : normalizeDecimal(payload.limitSellShares, pendingOrderLabels.limitSellShares, language);

  if (limitSellPrice !== null && limitSellPrice <= 0) {
    throw new Error(language === "zh" ? "当前挂卖单价格必须大于 0。" : "Current limit sell price must be greater than 0.");
  }

  if (limitSellShares < 0) {
    throw new Error(language === "zh" ? "当前挂卖单股数必须大于或等于 0。" : "Current limit sell shares must be 0 or greater.");
  }

  if (limitSellShares > 0 && limitSellPrice === null) {
    throw new Error(language === "zh" ? "如果已经挂了卖单股数，就必须填写挂卖单价格。" : "Current limit sell price is required when limit sell shares are greater than 0.");
  }

  if (limitSellPrice !== null && limitSellShares <= 0) {
    throw new Error(language === "zh" ? "如果已经填写挂卖单价格，就必须填写挂卖单股数。" : "Current limit sell shares are required when a limit sell price is set.");
  }

  if (limitSellShares > currentShares) {
    throw new Error(language === "zh" ? "当前挂卖单股数不能大于当前持股数。" : "Current limit sell shares cannot be greater than current shares.");
  }

  const fallbackRiskStyle = `${payload.riskStyle || ""}`.trim();
  const buyRiskStyle = `${payload.buyRiskStyle || fallbackRiskStyle || ""}`.trim();
  const sellRiskStyle = `${payload.sellRiskStyle || fallbackRiskStyle || ""}`.trim();

  if (!VALID_RISK_STYLES.has(buyRiskStyle) || !VALID_RISK_STYLES.has(sellRiskStyle)) {
    throw new Error(bgText(language, "chooseValidRiskStyle"));
  }

  const autoStopRule = `${payload.autoStopRule || "30m"}`.trim();

  if (!VALID_AUTO_STOP_RULES.has(autoStopRule)) {
    throw new Error(bgText(language, "chooseValidAutoStop"));
  }

  return {
    positionContext: {
      currentShares,
      averageCost: currentShares > 0 ? averageCost : null
    },
    capitalContext: {
      availableCash
    },
    pendingOrders: {
      limitBuyPrice,
      limitBuyShares,
      limitSellPrice,
      limitSellShares
    },
    rules: {
      allowAveragingDown: normalizeBoolean(payload.allowAveragingDown),
      allowReducingPosition: normalizeBoolean(payload.allowReducingPosition),
      buyRiskStyle,
      sellRiskStyle,
      riskStyle: buyRiskStyle,
      autoStopRule
    }
  };
}

async function stopMonitoring(reason = null) {
  await clearMonitoringAlarm();

  const currentState = await getState();
  const tabIds = getSessionTabIds(currentState);

  const nextState = await patchState({
    status: STATUS.IDLE,
    isRoundInFlight: false,
    monitoringProfile: null,
    lastMonitoringProfile: currentState.monitoringProfile || currentState.lastMonitoringProfile,
    stopReason: reason,
    lastError: null
  });

  for (const tabId of tabIds) {
    await chrome.sidePanel.setOptions({
      tabId,
      enabled: false
    }).catch(() => {});
  }

  return nextState;
}

async function exitMonitoring() {
  await clearMonitoringAlarm();

  const currentState = await getState();
  const tabIds = getSessionTabIds(currentState);

  await saveState(createDefaultState());

  for (const tabId of tabIds) {
    await chrome.sidePanel.setOptions({
      tabId,
      enabled: false
    }).catch(() => {});
  }

  return getState();
}

async function runValidationPreflight() {
  const language = await getUiLanguage();
  await clearMonitoringAlarm();

  await saveState({
    ...createDefaultState(),
    status: STATUS.VALIDATING
  });

  try {
    const capture = await captureActiveTab();
    const validation = validateStockChartByKeywordsWithLanguage({
      ...capture,
      language
    });
    const validationRecord = buildValidationRecord(validation, capture);

    if (!validation.isStockChart) {
      const state = await saveState({
        ...createDefaultState(),
        lastValidation: validationRecord,
        stopReason: bgText(language, "validationFailedChart")
      });

      if (capture.tabId) {
        await setSidePanelAvailabilityForTab(capture.tabId, {
          id: capture.tabId,
          title: capture.pageTitle,
          url: capture.pageUrl,
          windowId: capture.windowId
        });
      }

      await notifyUser(bgText(language, "notifyChartNotDetectedTitle"), bgText(language, "notifyChartNotDetectedBody"));

      return {
        ok: false,
        state
      };
    }

    const state = await saveState({
      ...createDefaultState(),
      status: STATUS.AWAITING_CONTEXT,
      lastValidation: validationRecord
    });

    if (capture.tabId) {
      await setSidePanelAvailabilityForTab(capture.tabId, {
        id: capture.tabId,
        title: capture.pageTitle,
        url: capture.pageUrl,
        windowId: capture.windowId
      });
    }

    return {
      ok: true,
      state
    };
  } catch (error) {
    const state = await saveState({
      ...createDefaultState(),
      lastError: error.message,
      stopReason: bgText(language, "validationFailedCapture")
    });

    await notifyUser(bgText(language, "notifyCaptureFailed"), error.message);

    return {
      ok: false,
      error: error.message,
      state
    };
  }
}

async function runMonitoringRound() {
  const language = await getUiLanguage();
  const currentState = await getState();
  const monitoringProfile = currentState.monitoringProfile;

  if (!monitoringProfile) {
    throw new Error(bgText(language, "fillFormFirst"));
  }

  if (currentState.roundCount >= currentState.maxRounds) {
    const state = await stopMonitoring(bgText(language, "reachedRounds", { maxRounds: currentState.maxRounds }));
    return { ok: false, state };
  }

  if (monitoringProfile.autoStopAt) {
    const autoStopAt = Date.parse(monitoringProfile.autoStopAt);

    if (Number.isFinite(autoStopAt) && Date.now() >= autoStopAt) {
      const state = await pauseMonitoring(
        getAutoStopReason(language, monitoringProfile.rules?.autoStopRule || "30m"),
        currentState
      );
      return { ok: false, state };
    }
  }

  if (monitoringProfile.boundTabId) {
    const activeTab = await getActiveTab(monitoringProfile.boundWindowId || null).catch(() => null);

    if (!activeTab || activeTab.id !== monitoringProfile.boundTabId) {
      const state = await pauseMonitoring(getPauseReason(language), currentState);
      return { ok: false, state };
    }
  }

  await patchState({
    ...currentState,
    status: STATUS.RUNNING,
    isRoundInFlight: true,
    stopReason: null,
    lastError: null
  });

  try {
    const capture = await captureActiveTab(monitoringProfile.boundWindowId || null);
    const validation = validateStockChartByKeywordsWithLanguage({
      ...capture,
      language
    });
    const validationRecord = buildValidationRecord(validation, capture);

    if (!validation.isStockChart) {
      const state = await patchState({
        status: STATUS.IDLE,
        isRoundInFlight: false,
        monitoringProfile: null,
        lastMonitoringProfile: monitoringProfile,
        lastValidation: validationRecord,
        stopReason: bgText(language, "monitoringStoppedChart"),
        lastError: null
      });

      await clearMonitoringAlarm();
      await notifyUser(bgText(language, "notifyMonitoringStopped"), bgText(language, "notifyCurrentTabNotChart"));

      return {
        ok: false,
        state
      };
    }

    const analysis = await analyzeChartCapture({
      ...capture,
      positionContext: monitoringProfile.positionContext,
      capitalContext: monitoringProfile.capitalContext,
      pendingOrders: monitoringProfile.pendingOrders,
      rules: monitoringProfile.rules
    });

    const round = currentState.roundCount + 1;
    const result = {
      id: createId(),
      round,
      capturedAt: new Date().toISOString(),
      pageTitle: capture.pageTitle,
      pageUrl: capture.pageUrl,
      monitoringProfile,
      validation: validationRecord,
      analysis
    };

    let state = await saveState({
      ...currentState,
      status: STATUS.RUNNING,
      isRoundInFlight: false,
      monitoringProfile,
      lastMonitoringProfile: monitoringProfile,
      roundCount: round,
      lastValidation: validationRecord,
      lastResult: result,
      results: [result, ...currentState.results].slice(0, MAX_RESULTS),
      stopReason: null,
      lastError: null
    });

    await notifyDiscordAnalysisResult(result, state, language);
    await playResultSound();

    if (round >= state.maxRounds) {
      await clearMonitoringAlarm();
      state = await saveState({
        ...state,
        status: STATUS.IDLE,
        isRoundInFlight: false,
        monitoringProfile: null,
        lastMonitoringProfile: monitoringProfile,
        stopReason: bgText(language, "reachedRounds", { maxRounds: state.maxRounds })
      });

      await notifyUser(bgText(language, "notifyMonitoringFinished"), bgText(language, "notifyStoppedAfterRounds", { maxRounds: state.maxRounds }));
    }

    return {
      ok: true,
      state,
      result
    };
  } catch (error) {
    const state = await saveState({
      ...currentState,
      status: STATUS.IDLE,
      isRoundInFlight: false,
      monitoringProfile: null,
      lastMonitoringProfile: monitoringProfile,
      lastError: error.message,
      stopReason: bgText(language, "monitoringStoppedAnalyze")
    });

    await clearMonitoringAlarm();
    await notifyUser(bgText(language, "notifyMonitoringStopped"), error.message);

    return {
      ok: false,
      error: error.message,
      state
    };
  }
}

async function startMonitoring(payload) {
  await ensureApiKeyConfigured();

  const activeTab = await getActiveTab();
  const monitoringProfile = refreshAutoStopDeadline(
    bindMonitoringProfileToTab(
      await buildMonitoringProfile(payload),
      activeTab
    )
  );

  await patchState({
    status: STATUS.RUNNING,
    isRoundInFlight: false,
    monitoringProfile,
    lastMonitoringProfile: monitoringProfile,
    stopReason: null,
    lastError: null
  });

  const roundResult = await runMonitoringRound();

  if (!roundResult.ok) {
    return roundResult;
  }

  scheduleMonitoringAlarm();

  return {
    ok: true,
    state: await getState()
  };
}

function getResumeSession(state) {
  const language = state?.__languageForError || "en";
  const monitoringProfile = state.monitoringProfile || state.lastMonitoringProfile;

  if (!monitoringProfile) {
    throw new Error(bgText(language, "noPreviousSession"));
  }

  return { monitoringProfile };
}

async function continueMonitoring() {
  await ensureApiKeyConfigured();

  const currentState = await getState();
  const language = await getUiLanguage();
  const { monitoringProfile: savedMonitoringProfile } = getResumeSession({
    ...currentState,
    __languageForError: language
  });

  await ensureMonitoringTabActive(savedMonitoringProfile, language);
  const monitoringProfile = refreshAutoStopDeadline(savedMonitoringProfile);

  await patchState({
    status: STATUS.RUNNING,
    isRoundInFlight: false,
    monitoringProfile,
    lastMonitoringProfile: monitoringProfile,
    stopReason: null,
    lastError: null
  });

  const roundResult = await runMonitoringRound();

  if (!roundResult.ok) {
    return roundResult;
  }

  scheduleMonitoringAlarm();

  return {
    ok: true,
    state: await getState()
  };
}

async function restartMonitoring() {
  await ensureApiKeyConfigured();
  await clearMonitoringAlarm();

  const currentState = await getState();
  const language = await getUiLanguage();
  const { monitoringProfile: savedMonitoringProfile } = getResumeSession({
    ...currentState,
    __languageForError: language
  });

  await ensureMonitoringTabActive(savedMonitoringProfile, language);
  const monitoringProfile = refreshAutoStopDeadline(savedMonitoringProfile);

  await saveState({
    ...createDefaultState(),
    status: STATUS.RUNNING,
    isRoundInFlight: false,
    monitoringProfile,
    lastMonitoringProfile: monitoringProfile
  });

  const roundResult = await runMonitoringRound();

  if (!roundResult.ok) {
    return roundResult;
  }

  scheduleMonitoringAlarm();

  return {
    ok: true,
    state: await getState()
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  await saveState(createDefaultState());
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();

  if (!state.updatedAt) {
    await saveState(createDefaultState());
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (activeTab?.id) {
    await setSidePanelAvailabilityForTab(activeTab.id, activeTab);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  const state = await getState();

  if (state.status !== STATUS.RUNNING || !state.monitoringProfile) {
    await clearMonitoringAlarm();
    return;
  }

  await runMonitoringRound();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await setSidePanelAvailabilityForTab(tabId);

  const state = await getState();
  const monitoringProfile = state.monitoringProfile || state.lastMonitoringProfile;

  if (state.status !== STATUS.RUNNING || !monitoringProfile?.boundTabId) {
    return;
  }

  const activatedTab = await getTabById(tabId);

  if (!activatedTab) {
    return;
  }

  if (activatedTab.windowId === monitoringProfile.boundWindowId && tabId !== monitoringProfile.boundTabId) {
    await pauseMonitoring(getPauseReason(await getUiLanguage()), state);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title && changeInfo.status !== "complete") {
    return;
  }

  await setSidePanelAvailabilityForTab(tabId, tab);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  const monitoringProfile = state.monitoringProfile || state.lastMonitoringProfile;

  if (!monitoringProfile?.boundTabId || tabId !== monitoringProfile.boundTabId) {
    return;
  }

  if (state.status === STATUS.RUNNING || state.status === STATUS.PAUSED) {
    await stopMonitoring(getClosedTabReason(await getUiLanguage()));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void sender;

  (async () => {
    if (message?.type === "play-result-sound") {
      return;
    }

    if (message?.type === "get-state") {
      sendResponse({ ok: true, state: await getState() });
      return;
    }

    if (message?.type === "start-validation") {
      sendResponse(await runValidationPreflight());
      return;
    }

    if (message?.type === "start-monitoring") {
      sendResponse(await startMonitoring(message));
      return;
    }

    if (message?.type === "stop-monitoring") {
      const language = await getUiLanguage();
      sendResponse({
        ok: true,
        state: await pauseMonitoring(getUserPauseReason(language))
      });
      return;
    }

    if (message?.type === "exit-monitoring") {
      sendResponse({
        ok: true,
        state: await exitMonitoring()
      });
      return;
    }

    if (message?.type === "continue-monitoring") {
      sendResponse(await continueMonitoring());
      return;
    }

    if (message?.type === "restart-monitoring") {
      sendResponse(await restartMonitoring());
      return;
    }

    sendResponse({
      ok: false,
      error: "Unknown message type."
    });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error.message
    });
  });

  return true;
});
