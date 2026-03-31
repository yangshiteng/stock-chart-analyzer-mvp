import {
  ALARM_MINUTES,
  ALARM_NAME,
  INTENT_OPTIONS,
  MAX_RESULTS,
  MODE,
  STATUS,
  createDefaultState
} from "./lib/constants.js";
import { validateStockChartByKeywordsWithLanguage } from "./lib/chart-validator.js";
import { getLanguage } from "./lib/i18n.js";
import { analyzeChartCapture } from "./lib/llm.js";
import { getSettings, getState, patchState, saveState } from "./lib/storage.js";

const ICON_PATH = "assets/icon-128.png";
const SIDEPANEL_PATH = "sidepanel.html";

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

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function getDiscordModeLabel(language, mode) {
  if (mode === MODE.BUY) {
    return language === "zh" ? "买入" : "Buy";
  }

  if (mode === MODE.SELL) {
    return language === "zh" ? "卖出" : "Sell";
  }

  return mode || (language === "zh" ? "未知" : "Unknown");
}

function getDiscordActionLabel(language, signal) {
  if (signal === "BUY") {
    return language === "zh" ? "买入" : "Buy";
  }

  if (signal === "SELL") {
    return language === "zh" ? "卖出" : "Sell";
  }

  if (signal === "WAIT_FOR_CONFIRMATION") {
    return language === "zh" ? "先等待确认" : "Wait for confirmation";
  }

  return language === "zh" ? "先观望" : "Stand aside";
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

function getDiscordColor(signal) {
  if (signal === "BUY") {
    return 0x1f8f4e;
  }

  if (signal === "SELL") {
    return 0xb64a3a;
  }

  if (signal === "WAIT_FOR_CONFIRMATION") {
    return 0xa57008;
  }

  return 0x4f718c;
}

function getDiscordFallback(language) {
  return language === "zh" ? "无" : "N/A";
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
  const timeframe = analysis.timeframe || fallback;
  const action = getDiscordActionLabel(language, analysis.signal);
  const mode = getDiscordModeLabel(language, analysis.mode || result?.mode);
  const clarity = getDiscordClarityLabel(language, analysis.confidence);
  const watchLevel = levels.entry || analysis.limitPrice || fallback;
  const target = levels.target || fallback;
  const riskTrigger = levels.invalidation || fallback;
  const position = getDiscordPositionSummary(language, result?.monitoringProfile);
  const description = truncateText(
    analysis.summary || (language === "zh" ? "新的图表分析结果已生成。" : "A new chart analysis result is ready."),
    350
  );

  return {
    username: language === "zh" ? "股票图表分析器" : "Stock Chart Analyzer",
    allowed_mentions: {
      parse: []
    },
    embeds: [
      {
        title: language === "zh" ? `最新建议 · ${symbol}` : `Latest Recommendation · ${symbol}`,
        url: result?.pageUrl || undefined,
        description,
        color: getDiscordColor(analysis.signal),
        fields: [
          {
            name: language === "zh" ? "当前动作" : "Action Now",
            value: truncateText(action, 100),
            inline: true
          },
          {
            name: language === "zh" ? "模式" : "Mode",
            value: truncateText(mode, 100),
            inline: true
          },
          {
            name: language === "zh" ? "信号清晰度" : "Signal Clarity",
            value: truncateText(clarity, 100),
            inline: true
          },
          {
            name: language === "zh" ? "关注价位" : "Watch Level",
            value: truncateText(watchLevel, 250),
            inline: true
          },
          {
            name: language === "zh" ? "目标位" : "Target",
            value: truncateText(target, 250),
            inline: true
          },
          {
            name: language === "zh" ? "风险触发位" : "Risk Trigger",
            value: truncateText(riskTrigger, 250),
            inline: true
          },
          {
            name: language === "zh" ? "周期" : "Timeframe",
            value: truncateText(timeframe, 100),
            inline: true
          },
          {
            name: language === "zh" ? "持仓" : "Position",
            value: truncateText(position, 250),
            inline: true
          }
        ],
        footer: {
          text: language === "zh"
            ? `第 ${result?.round || state?.roundCount || 0} / ${state?.maxRounds || 0} 轮`
            : `Round ${result?.round || state?.roundCount || 0} of ${state?.maxRounds || 0}`
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
      body: JSON.stringify(buildDiscordAnalysisPayload(result, state, language))
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
      saveApiKeyFirst: "Save your OpenAI API key in the side panel before choosing Buy or Sell.",
      modeMustBeBuyOrSell: "Mode must be either buy or sell.",
      chooseValidIntent: "Choose a valid trading intent.",
      mustBeNumber: "{label} must be a number.",
      currentSharesLabel: "Current shares",
      averageCostLabel: "Average cost",
      currentSharesMin: "Current shares must be 0 or greater.",
      averageCostMin: "Average cost must be greater than 0.",
      requiresExistingPosition: "This setup requires an existing position with shares greater than 0.",
      averageCostRequired: "Average cost is required for this setup.",
      validationFailedChart: "Validation failed because the current tab does not look like a stock chart.",
      notifyChartNotDetectedTitle: "Stock chart not detected",
      notifyChartNotDetectedBody: "Monitoring stopped because the current tab is not recognized as a stock chart.",
      validationFailedCapture: "Validation failed because the tab could not be captured.",
      notifyCaptureFailed: "Capture failed",
      chooseModeFirst: "Choose Buy or Sell mode first.",
      fillFormFirst: "Fill in the position form before starting monitoring.",
      reachedRounds: "Reached {maxRounds} rounds.",
      monitoringStoppedChart: "Monitoring stopped because the current tab is no longer recognized as a stock chart.",
      notifyMonitoringStopped: "Monitoring stopped",
      notifyCurrentTabNotChart: "The current tab is no longer recognized as a stock chart.",
      notifyMonitoringFinished: "Monitoring finished",
      notifyStoppedAfterRounds: "Stopped after {maxRounds} rounds.",
      monitoringStoppedAnalyze: "Monitoring stopped because the current tab could not be analyzed.",
      stoppedByUser: "Monitoring stopped by the user.",
      noPreviousSession: "No previous monitoring session is available yet."
    },
    zh: {
      noActiveTab: "没有找到当前活动标签页。请先聚焦到图表页面后再试。",
      untitledTab: "未命名标签页",
      saveApiKeyFirst: "在选择买入或卖出之前，请先在侧边栏中保存 OpenAI 密钥。",
      modeMustBeBuyOrSell: "模式必须是“买入”或“卖出”。",
      chooseValidIntent: "请选择有效的交易意图。",
      mustBeNumber: "{label} 必须是数字。",
      currentSharesLabel: "当前持股数",
      averageCostLabel: "平均成本",
      currentSharesMin: "当前持股数必须大于或等于 0。",
      averageCostMin: "平均成本必须大于 0。",
      requiresExistingPosition: "当前设置要求你已经有持仓，持股数必须大于 0。",
      averageCostRequired: "当前设置必须填写平均成本。",
      validationFailedChart: "校验失败，因为当前标签页看起来不像股票图表。",
      notifyChartNotDetectedTitle: "未识别到股票图表",
      notifyChartNotDetectedBody: "监控已停止，因为当前标签页未被识别为股票图表。",
      validationFailedCapture: "校验失败，因为当前标签页无法被截取。",
      notifyCaptureFailed: "截图失败",
      chooseModeFirst: "请先选择买入或卖出模式。",
      fillFormFirst: "开始监控前请先填写持仓表单。",
      reachedRounds: "已达到 {maxRounds} 轮。",
      monitoringStoppedChart: "监控已停止，因为当前标签页不再被识别为股票图表。",
      notifyMonitoringStopped: "监控已停止",
      notifyCurrentTabNotChart: "当前标签页不再被识别为股票图表。",
      notifyMonitoringFinished: "监控已完成",
      notifyStoppedAfterRounds: "已在 {maxRounds} 轮后停止。",
      monitoringStoppedAnalyze: "监控已停止，因为当前标签页无法完成分析。",
      stoppedByUser: "监控已由用户手动停止。",
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
  const mode = state.mode || state.lastMode || monitoringProfile?.mode || null;
  const boundTabId = monitoringProfile?.boundTabId || state.lastValidation?.tabId || null;

  const nextState = await patchState({
    status: STATUS.PAUSED,
    isRoundInFlight: false,
    mode,
    monitoringProfile,
    lastMode: mode,
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

  if (state.status === STATUS.AWAITING_MODE || state.status === STATUS.AWAITING_CONTEXT) {
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

async function buildMonitoringProfile({ mode, currentShares, averageCost, intent }) {
  const language = await getUiLanguage();

  if (![MODE.BUY, MODE.SELL].includes(mode)) {
    throw new Error(bgText(language, "modeMustBeBuyOrSell"));
  }

  const allowedIntents = (INTENT_OPTIONS[mode] || []).map((option) => option.value);

  if (!allowedIntents.includes(intent)) {
    throw new Error(bgText(language, "chooseValidIntent"));
  }

  const normalizedShares = normalizeDecimal(currentShares, bgText(language, "currentSharesLabel"), language);

  if (normalizedShares < 0) {
    throw new Error(bgText(language, "currentSharesMin"));
  }

  const normalizedAverageCost = averageCost === "" || averageCost === null || averageCost === undefined
    ? null
    : normalizeDecimal(averageCost, bgText(language, "averageCostLabel"), language);

  if (normalizedAverageCost !== null && normalizedAverageCost <= 0) {
    throw new Error(bgText(language, "averageCostMin"));
  }

  const requiresExistingPosition = mode === MODE.SELL || intent !== "new_position";

  if (requiresExistingPosition && normalizedShares <= 0) {
    throw new Error(bgText(language, "requiresExistingPosition"));
  }

  if (requiresExistingPosition && normalizedAverageCost === null) {
    throw new Error(bgText(language, "averageCostRequired"));
  }

  return {
    mode,
    intent,
    positionContext: {
      currentShares: normalizedShares,
      averageCost: normalizedShares > 0 ? normalizedAverageCost : null
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
    mode: null,
    monitoringProfile: null,
    lastMode: currentState.mode || currentState.lastMode,
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

async function beginMonitoringSetup(mode) {
  await ensureApiKeyConfigured();
  const language = await getUiLanguage();

  if (![MODE.BUY, MODE.SELL].includes(mode)) {
    throw new Error(bgText(language, "modeMustBeBuyOrSell"));
  }

  return patchState({
    status: STATUS.AWAITING_CONTEXT,
    mode,
    lastMode: mode,
    monitoringProfile: null,
    stopReason: null,
    lastError: null
  });
}

async function returnToModeSelection() {
  return patchState({
    status: STATUS.AWAITING_MODE,
    mode: null,
    monitoringProfile: null,
    stopReason: null,
    lastError: null
  });
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

      await notifyUser(bgText(language, "notifyChartNotDetectedTitle"), bgText(language, "notifyChartNotDetectedBody"));

      return {
        ok: false,
        state
      };
    }

    const state = await saveState({
      ...createDefaultState(),
      status: STATUS.AWAITING_MODE,
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

async function runMonitoringRound(modeOverride = null) {
  const language = await getUiLanguage();
  const currentState = await getState();
  const mode = modeOverride || currentState.mode;
  const monitoringProfile = currentState.monitoringProfile;

  if (!mode) {
    throw new Error(bgText(language, "chooseModeFirst"));
  }

  if (!monitoringProfile) {
    throw new Error(bgText(language, "fillFormFirst"));
  }

  if (currentState.roundCount >= currentState.maxRounds) {
    const state = await stopMonitoring(bgText(language, "reachedRounds", { maxRounds: currentState.maxRounds }));
    return { ok: false, state };
  }

  if (monitoringProfile?.boundTabId) {
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
    const capture = await captureActiveTab(monitoringProfile?.boundWindowId || null);
    const validation = validateStockChartByKeywordsWithLanguage({
      ...capture,
      language
    });
    const validationRecord = buildValidationRecord(validation, capture);

    if (!validation.isStockChart) {
      const state = await patchState({
        status: STATUS.IDLE,
        isRoundInFlight: false,
        mode: null,
        monitoringProfile: null,
        lastMode: mode,
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
      mode,
      intent: monitoringProfile.intent,
      positionContext: monitoringProfile.positionContext
    });

    const round = currentState.roundCount + 1;
    const result = {
      id: createId(),
      round,
      mode,
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
      mode,
      lastMode: mode,
      lastMonitoringProfile: monitoringProfile,
      roundCount: round,
      lastValidation: validationRecord,
      lastResult: result,
      results: [result, ...currentState.results].slice(0, MAX_RESULTS),
      stopReason: null,
      lastError: null
    });

    await notifyDiscordAnalysisResult(result, state, language);

    if (round >= state.maxRounds) {
      await clearMonitoringAlarm();
      state = await saveState({
        ...state,
        status: STATUS.IDLE,
        isRoundInFlight: false,
        mode: null,
        monitoringProfile: null,
        lastMode: mode,
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
      mode: null,
      monitoringProfile: null,
      lastMode: mode,
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
  const monitoringProfile = bindMonitoringProfileToTab(
    await buildMonitoringProfile(payload),
    activeTab
  );

  await patchState({
    status: STATUS.RUNNING,
    isRoundInFlight: false,
    mode: monitoringProfile.mode,
    monitoringProfile,
    lastMode: monitoringProfile.mode,
    lastMonitoringProfile: monitoringProfile,
    stopReason: null,
    lastError: null
  });

  const roundResult = await runMonitoringRound(monitoringProfile.mode);

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
  const mode = state.mode || state.lastMode || monitoringProfile?.mode || null;

  if (!mode || !monitoringProfile) {
    throw new Error(bgText(language, "noPreviousSession"));
  }

  return {
    mode,
    monitoringProfile: {
      ...monitoringProfile,
      mode
    }
  };
}

async function continueMonitoring() {
  await ensureApiKeyConfigured();

  const currentState = await getState();
  const language = await getUiLanguage();
  const { mode, monitoringProfile } = getResumeSession({
    ...currentState,
    __languageForError: language
  });
  await ensureMonitoringTabActive(monitoringProfile, language);

  await patchState({
    status: STATUS.RUNNING,
    isRoundInFlight: false,
    mode,
    monitoringProfile,
    lastMode: mode,
    lastMonitoringProfile: monitoringProfile,
    stopReason: null,
    lastError: null
  });

  const roundResult = await runMonitoringRound(mode);

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
  const { mode, monitoringProfile } = getResumeSession({
    ...currentState,
    __languageForError: language
  });
  await ensureMonitoringTabActive(monitoringProfile, language);

  await saveState({
    ...createDefaultState(),
    status: STATUS.RUNNING,
    isRoundInFlight: false,
    mode,
    monitoringProfile,
    lastMode: mode,
    lastMonitoringProfile: monitoringProfile
  });

  const roundResult = await runMonitoringRound(mode);

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

  if (state.status !== STATUS.RUNNING || !state.mode) {
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
    if (message?.type === "get-state") {
      sendResponse({ ok: true, state: await getState() });
      return;
    }

    if (message?.type === "start-validation") {
      sendResponse(await runValidationPreflight());
      return;
    }

    if (message?.type === "choose-mode") {
      sendResponse({
        ok: true,
        state: await beginMonitoringSetup(message.mode)
      });
      return;
    }

    if (message?.type === "back-to-mode-selection") {
      sendResponse({
        ok: true,
        state: await returnToModeSelection()
      });
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
