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
import { getLanguage, t } from "./lib/i18n.js";
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

function getSafeDiscordFallback(language) {
  return t(language, "nA");
}

function getSafeDiscordActionLabel(language, action) {
  const key = `action_${action}`;
  const label = t(language, key);
  return label === key ? t(language, "unknown") : label;
}

function formatDiscordLevelCluster(levels, fallback) {
  if (!levels) {
    return fallback;
  }

  if (typeof levels === "string") {
    return truncateText(levels || fallback, 250);
  }

  const primary = levels.primary && levels.primary !== "N/A" ? `${levels.primary}` : "";
  const secondary = levels.secondary && levels.secondary !== "N/A" ? `${levels.secondary}` : "";
  const combined = [primary, secondary].filter(Boolean).join(" / ");

  return truncateText(combined || fallback, 250);
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


function buildDiscordAnalysisPayloadV4(result, state, language) {
  const analysis = result?.analysis || {};
  const levels = analysis.levels || {};
  const fallback = getSafeDiscordFallback(language);
  const symbol = analysis.symbol || result?.validation?.symbolGuess || fallback;
  const description = truncateText(
    analysis.whatToDoNow
      || analysis.summary
      || (language === "zh" ? "新的图表分析结果已经生成。" : "A new chart analysis result is ready."),
    350
  );

  return {
    username: t(language, "appTitle"),
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `${t(language, "latestRecommendation")} - ${symbol}`,
        url: result?.pageUrl || undefined,
        description,
        color: getDiscordColor(analysis.action),
        fields: [
          {
            name: t(language, "actionNow"),
            value: truncateText(getSafeDiscordActionLabel(language, analysis.action), 100),
            inline: true
          },
          {
            name: t(language, "currentPrice"),
            value: truncateText(analysis.currentPrice || fallback, 120),
            inline: true
          },
          {
            name: t(language, "currentSupport"),
            value: formatDiscordLevelCluster(analysis.supportLevels, levels.entry || fallback),
            inline: true
          },
          {
            name: t(language, "currentResistance"),
            value: formatDiscordLevelCluster(analysis.resistanceLevels, levels.target || fallback),
            inline: true
          },
          {
            name: t(language, "riskTrigger"),
            value: truncateText(levels.invalidation || fallback, 250),
            inline: true
          },
          {
            name: t(language, "suggestedSize"),
            value: truncateText(analysis.sizeSuggestion || fallback, 250),
            inline: true
          },
          {
            name: t(language, "watchOut"),
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
      body: JSON.stringify(buildDiscordAnalysisPayloadV4(result, state, language))
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
  const en = {
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
    fillFormFirst: "Fill in the trading settings form before starting monitoring.",
    monitoringStoppedChart: "Monitoring stopped because the current tab is no longer recognized as a stock chart.",
    notifyMonitoringStopped: "Monitoring stopped",
    notifyMonitoringPaused: "Monitoring paused",
    notifyCurrentTabNotChart: "The current tab is no longer recognized as a stock chart.",
    monitoringStoppedAnalyze: "This round failed, so monitoring has been paused.",
    stoppedByUser: "Monitoring paused by the user.",
    noPreviousSession: "No previous monitoring session is available yet."
  };
  const zh = {
    noActiveTab: "没有找到当前活动标签页。请先切到图表页再试。",
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
    chooseValidRiskStyle: "请选择有效的风险偏好。",
    chooseValidAutoStop: "请选择有效的自动停止选项。",
    validationFailedChart: "校验失败，因为当前标签页看起来不像股票图。",
    notifyChartNotDetectedTitle: "未识别到股票图表",
    notifyChartNotDetectedBody: "监控已停止，因为当前标签页未被识别为股票图表。",
    validationFailedCapture: "校验失败，因为当前标签页无法被截图。",
    notifyCaptureFailed: "截图失败",
    fillFormFirst: "开始监控前请先填写交易设置表单。",
    monitoringStoppedChart: "监控已停止，因为当前标签页不再被识别为股票图表。",
    notifyMonitoringStopped: "监控已停止",
    notifyMonitoringPaused: "监控已暂停",
    notifyCurrentTabNotChart: "当前标签页不再被识别为股票图表。",
    monitoringStoppedAnalyze: "这一轮分析失败，监控已暂停。",
    stoppedByUser: "监控已由用户手动暂停。",
    noPreviousSession: "目前还没有可继续的历史监控会话。"
  };

  const locale = language === "zh" ? zh : en;  const template = locale[key] || en[key] || key;
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
    ? "监控已暂停，因为你离开了最初启动监控的图表标签页。回到原始图表页后即可继续。"
    : "Monitoring paused because you left the original chart tab. Return to that tab to continue.";
}

function getClosedTabReason(language) {
  return language === "zh"
    ? "监控已停止，因为最初绑定的图表标签页已经被关闭。"
    : "Monitoring stopped because the original chart tab was closed.";
}

function getUserPauseReason(language) {
  return language === "zh"
    ? "监控已由用户手动暂停。"
    : "Monitoring paused by the user.";
}

function getResumeTabMismatchReason(language) {
  return language === "zh"
    ? "继续监控前，请先回到最初启动监控的图表标签页。"
    : "Return to the original chart tab before continuing monitoring.";
}

function getResumeTabMissingReason(language) {
  return language === "zh"
    ? "最初绑定的图表标签页已不存在。请回到图表页重新开始。"
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

async function pauseMonitoring(reason, currentState = null, lastError = null) {
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
    lastError
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

function normalizeRiskStyleValue(value) {
  return VALID_RISK_STYLES.has(value) ? value : "conservative";
}

function getAutoStopMinutes(rule) {
  return AUTO_STOP_MINUTES.get(rule) ?? null;
}

function normalizeAutoStopRule(rule) {
  return VALID_AUTO_STOP_RULES.has(rule) ? rule : "30m";
}

function refreshAutoStopDeadline(monitoringProfile) {
  const normalizedProfile = monitoringProfile
    ? {
        ...monitoringProfile,
        rules: {
          buyRiskStyle: normalizeRiskStyleValue(`${monitoringProfile.rules?.buyRiskStyle || "conservative"}`.trim()),
          sellRiskStyle: normalizeRiskStyleValue(`${monitoringProfile.rules?.sellRiskStyle || "conservative"}`.trim()),
          autoStopRule: normalizeAutoStopRule(monitoringProfile.rules?.autoStopRule)
        }
      }
    : null;
  const autoStopRule = normalizeAutoStopRule(normalizedProfile?.rules?.autoStopRule);
  const minutes = getAutoStopMinutes(autoStopRule);

  return {
    ...normalizedProfile,
    rules: {
      ...normalizedProfile?.rules,
      autoStopRule
    },
    autoStopAt: minutes ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : null
  };
}

function getAutoStopLabel(language, rule) {
  const normalizedRule = normalizeAutoStopRule(rule);
  const labels = {
    off: language === "zh" ? "关闭" : "off",
    "30m": language === "zh" ? "30 分钟" : "30 minutes",
    "1h": language === "zh" ? "1 小时" : "1 hour",
    "2h": language === "zh" ? "2 小时" : "2 hours",
    "4h": language === "zh" ? "4 小时" : "4 hours"
  };

  if (normalizedRule === "8h") {
    return language === "zh" ? "8 小时" : "8 hours";
  }

  return labels[normalizedRule] || labels["30m"];
}

function getAutoStopReason(language, rule) {
  const label = getAutoStopLabel(language, rule);

  return language === "zh"
    ? "监控已在运行 " + label + " 后自动暂停。"
    : `Monitoring paused automatically after ${label}.`;
}

async function buildMonitoringProfile(payload) {
  const language = await getUiLanguage();
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

  const buyRiskStyle = `${payload.buyRiskStyle || ""}`.trim();
  const sellRiskStyle = `${payload.sellRiskStyle || ""}`.trim();

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
    rules: {
      buyRiskStyle,
      sellRiskStyle,
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

    return {
      ok: true,
      state,
      result
    };
  } catch (error) {
    const state = await pauseMonitoring(
      bgText(language, "monitoringStoppedAnalyze"),
      currentState,
      error.message
    );

    await notifyUser(bgText(language, "notifyMonitoringPaused"), error.message);

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


