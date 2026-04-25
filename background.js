import {
  ALARM_NAME,
  ANALYSIS_INTERVAL_OPTIONS,
  DEFAULT_ANALYSIS_INTERVAL,
  DEFAULT_TOTAL_ROUNDS,
  MAX_RESULTS,
  MAX_TRADE_HISTORY,
  STATUS,
  TOTAL_ROUNDS_OPTIONS,
  createDefaultState
} from "./lib/constants.js";
import { validateStockChartByKeywordsWithLanguage } from "./lib/chart-validator.js";
import { getLanguage, t } from "./lib/i18n.js";
import { analyzeChartCapture, generateLongTermContext, generateTradeLesson, LONG_TERM_TIMEFRAMES, USER_CONTEXT_MAX_LENGTH } from "./lib/llm.js";
import { getUsTradingDay, isNearUsMarketClose, isWithinUsMarketHours } from "./lib/market-hours.js";
import {
  SIDEPANEL_PATH,
  enableSidePanelForWindow,
  setSidePanelAvailabilityForTab
} from "./lib/side-panel.js";
import { getSettings, getState, patchState, saveState } from "./lib/storage.js";

const ICON_PATH = "assets/icon-128.png";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const ANALYSIS_INTERVAL_MINUTES = new Map(ANALYSIS_INTERVAL_OPTIONS.map((option) => [option.value, option.minutes]));
const VALID_ANALYSIS_INTERVALS = new Set(ANALYSIS_INTERVAL_OPTIONS.map((option) => option.value));
const TOTAL_ROUNDS_MAP = new Map(TOTAL_ROUNDS_OPTIONS.map((option) => [option.value, option.rounds]));
const VALID_TOTAL_ROUNDS = new Set(TOTAL_ROUNDS_OPTIONS.map((option) => option.value));
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

function getDiscordColor(action) {
  if (action === "BUY_NOW" || action === "BUY_LIMIT") {
    return 0x1f8f4e;
  }

  if (action === "SELL_NOW" || action === "SELL_LIMIT") {
    return 0xb64a3a;
  }

  if (action === "WAIT") {
    return 0xa57008;
  }

  return 0x4f718c;
}


function buildDiscordAnalysisPayloadV4(result, state, language) {
  const analysis = result?.analysis || {};
  const fallback = getSafeDiscordFallback(language);
  const symbol = analysis.symbol || result?.validation?.symbolGuess || fallback;
  const description = truncateText(
    analysis.reasoning
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
            name: t(language, "confidenceLabel"),
            value: truncateText(analysis.confidence || fallback, 60),
            inline: true
          },
          {
            name: t(language, "entryPriceLabel"),
            value: truncateText(analysis.entryPrice || fallback, 120),
            inline: true
          },
          {
            name: t(language, "stopLossPriceLabel"),
            value: truncateText(analysis.stopLossPrice || fallback, 120),
            inline: true
          },
          {
            name: t(language, "targetPriceLabel"),
            value: truncateText(analysis.targetPrice || fallback, 120),
            inline: true
          },
          {
            name: t(language, "triggerConditionLabel"),
            value: truncateText(analysis.triggerCondition || fallback, 300),
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


function scheduleMonitoringAlarm(intervalMinutes = DEFAULT_ANALYSIS_INTERVAL) {
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: intervalMinutes,
    periodInMinutes: intervalMinutes
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
    throw new Error(t(language, "noActiveTab"));
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
    pageTitle: tab.title || t(await getUiLanguage(), "untitledTab"),
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
    throw new Error(t(language, "resumeTabMissing"));
  }

  const activeTab = await getActiveTab(monitoringProfile?.boundWindowId || null);

  if (activeTab.id !== boundTab.id) {
    throw new Error(t(language, "resumeTabMismatch"));
  }

  return boundTab;
}

async function ensureApiKeyConfigured() {
  const settings = await getSettings();

  if (!settings.openaiApiKey) {
    throw new Error(t(getLanguage(settings.language), "saveApiKeyFirst"));
  }
}

function getAnalysisIntervalMinutes(rule) {
  return ANALYSIS_INTERVAL_MINUTES.get(rule) ?? DEFAULT_ANALYSIS_INTERVAL;
}

function normalizeAnalysisInterval(rule) {
  return VALID_ANALYSIS_INTERVALS.has(rule) ? rule : "5m";
}

function getTotalRoundsValue(rule) {
  return TOTAL_ROUNDS_MAP.get(`${rule}`) ?? DEFAULT_TOTAL_ROUNDS;
}

function normalizeTotalRounds(rule) {
  return VALID_TOTAL_ROUNDS.has(`${rule}`) ? `${rule}` : `${DEFAULT_TOTAL_ROUNDS}`;
}

function normalizeMonitoringProfileRules(monitoringProfile) {
  if (!monitoringProfile) {
    return null;
  }

  return {
    ...monitoringProfile,
    rules: {
      analysisInterval: normalizeAnalysisInterval(monitoringProfile.rules?.analysisInterval),
      totalRounds: normalizeTotalRounds(monitoringProfile.rules?.totalRounds)
    }
  };
}

function getAnalysisIntervalLabel(language, rule) {
  return t(language, `analysisInterval_${normalizeAnalysisInterval(rule)}`);
}

function getTotalRoundsLabel(language, rule) {
  return t(language, `totalRounds_${normalizeTotalRounds(rule)}`);
}

function getCompletedRoundsReason(language, totalRounds) {
  return t(language, "completedRounds", { rounds: getTotalRoundsLabel(language, totalRounds) });
}

async function buildMonitoringProfile(payload) {
  const language = await getUiLanguage();
  const symbolOverride = `${payload.symbolOverride || ""}`.trim().toUpperCase().slice(0, 10) || null;

  if (!symbolOverride) {
    throw new Error(t(language, "symbolRequired"));
  }

  const analysisInterval = `${payload.analysisInterval || "5m"}`.trim();

  if (!VALID_ANALYSIS_INTERVALS.has(analysisInterval)) {
    throw new Error(t(language, "chooseValidAnalysisInterval"));
  }

  const totalRounds = `${payload.totalRounds || `${DEFAULT_TOTAL_ROUNDS}`}`.trim();

  if (!VALID_TOTAL_ROUNDS.has(totalRounds)) {
    throw new Error(t(language, "chooseValidTotalRounds"));
  }

  // Optional user-supplied background notes (fundamentals, ATH, earnings, macro…).
  // Capped at USER_CONTEXT_MAX_LENGTH so the prompt stays bounded; extra chars are dropped.
  const rawUserContext = typeof payload.userContext === "string" ? payload.userContext : "";
  const userContext = rawUserContext.trim().slice(0, USER_CONTEXT_MAX_LENGTH);

  return {
    symbolOverride,
    userContext,
    rules: {
      analysisInterval,
      totalRounds
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

async function markBought(payload) {
  const language = await getUiLanguage();
  const currentState = await getState();
  if (currentState.status !== STATUS.RUNNING) {
    throw new Error(t(language, "markBoughtNotRunning"));
  }
  if (currentState.virtualPosition) {
    throw new Error(t(language, "markBoughtAlreadyHolding"));
  }

  const entryPriceRaw = `${payload?.entryPrice ?? ""}`.trim();
  const entryPrice = Number(entryPriceRaw);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error(t(language, "entryPriceInvalid"));
  }

  // Prefer the pending limit order's captured snapshot over lastResult — lastResult may have
  // moved on to a different signal by the time the limit fills several rounds later.
  const pending = currentState.pendingLimitOrder;
  const suggestion = currentState.lastResult?.analysis || {};
  const source = pending || suggestion;
  const now = new Date();
  const virtualPosition = {
    entryPrice: entryPriceRaw,
    entryTime: now.toISOString(),
    tradingDay: getUsTradingDay(now),
    stopLossPrice: source.stopLossPrice || suggestion.stopLossPrice || null,
    targetPrice: source.targetPrice || suggestion.targetPrice || null,
    reason: source.reasoning || source.reason || suggestion.reasoning || suggestion.triggerCondition || null,
    symbol: currentState.monitoringProfile?.symbolOverride || source.symbol || suggestion.symbol || null,
    sourceRound: pending?.sourceRound ?? currentState.roundCount ?? 0,
    entryAction: pending?.action || suggestion.action || null,
    entryConfidence: pending?.confidence || suggestion.confidence || null
  };

  const state = await patchState({
    virtualPosition,
    pendingLimitOrder: null,
    lastError: null
  });
  return { ok: true, state };
}

async function markLimitPlaced(payload) {
  const language = await getUiLanguage();
  const currentState = await getState();
  if (currentState.status !== STATUS.RUNNING) {
    throw new Error(t(language, "markBoughtNotRunning"));
  }

  const suggestion = currentState.lastResult?.analysis || {};
  const action = suggestion.action;
  if (action !== "BUY_LIMIT" && action !== "SELL_LIMIT") {
    throw new Error(t(language, "limitNotLimitSignal"));
  }
  // Symmetry checks: BUY_LIMIT requires flat, SELL_LIMIT requires an open position.
  if (action === "BUY_LIMIT" && currentState.virtualPosition) {
    throw new Error(t(language, "limitBuyWhileHolding"));
  }
  if (action === "SELL_LIMIT" && !currentState.virtualPosition) {
    throw new Error(t(language, "limitSellWithoutPosition"));
  }
  if (currentState.pendingLimitOrder) {
    throw new Error(t(language, "limitAlreadyPending"));
  }

  const limitPriceRaw = `${payload?.limitPrice ?? suggestion.entryPrice ?? ""}`.trim();
  const limitPrice = Number(limitPriceRaw);
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
    throw new Error(t(language, "limitPriceInvalid"));
  }

  const pendingLimitOrder = {
    action,
    limitPrice: limitPriceRaw,
    stopLossPrice: suggestion.stopLossPrice || null,
    targetPrice: suggestion.targetPrice || null,
    reasoning: suggestion.reasoning || suggestion.triggerCondition || null,
    confidence: suggestion.confidence || null,
    symbol: currentState.monitoringProfile?.symbolOverride || suggestion.symbol || null,
    placedAt: new Date().toISOString(),
    sourceRound: currentState.roundCount || 0
  };

  const state = await patchState({ pendingLimitOrder, lastError: null });
  return { ok: true, state };
}

async function updateUserContext(payload) {
  const language = await getUiLanguage();
  const currentState = await getState();
  // Only allow edits while a session is live — avoids editing stale profiles.
  if (currentState.status !== STATUS.RUNNING) {
    throw new Error(t(language, "backgroundNotesNotRunning"));
  }
  if (!currentState.monitoringProfile) {
    throw new Error(t(language, "backgroundNotesNotRunning"));
  }

  const raw = typeof payload?.userContext === "string" ? payload.userContext : "";
  if (raw.length > USER_CONTEXT_MAX_LENGTH) {
    throw new Error(t(language, "backgroundNotesTooLong", { max: USER_CONTEXT_MAX_LENGTH }));
  }
  const trimmed = raw.trim().slice(0, USER_CONTEXT_MAX_LENGTH);

  const monitoringProfile = { ...currentState.monitoringProfile, userContext: trimmed };
  const state = await patchState({
    monitoringProfile,
    lastMonitoringProfile: monitoringProfile
  });
  return { ok: true, state };
}

// Pre-session entry point: capture the active tab, ask the LLM for a higher-timeframe
// structural read, and stash the result in `state.longTermContextDraft`. The draft is
// copied into the new monitoringProfile on Start, then cleared. Live-session regeneration
// is intentionally NOT supported — once a session starts, the long-term anchor is frozen
// for that session. To refresh, exit and start a new session.
async function generateLongTermContextHandler(payload) {
  await ensureApiKeyConfigured();

  const timeframe = LONG_TERM_TIMEFRAMES.includes(payload?.timeframe) ? payload.timeframe : "daily";
  const currentState = await getState();
  const capture = await captureActiveTab();

  const longTermContext = await generateLongTermContext({
    ...capture,
    timeframe,
    symbolHint: currentState.monitoringProfile?.symbolOverride
      || currentState.lastMonitoringProfile?.symbolOverride
      || null
  });

  const state = await patchState({
    longTermContextDraft: longTermContext,
    lastError: null
  });
  return { ok: true, state, longTermContext };
}

async function markLimitCancelled() {
  const currentState = await getState();
  if (!currentState.pendingLimitOrder) {
    // Idempotent — already no pending. Not an error.
    return { ok: true, state: currentState };
  }
  const state = await patchState({ pendingLimitOrder: null });
  return { ok: true, state };
}

async function markSold(payload) {
  const language = await getUiLanguage();
  const currentState = await getState();
  if (!currentState.virtualPosition) {
    throw new Error(t(language, "markSoldNotHolding"));
  }

  const exitPriceRaw = `${payload?.exitPrice ?? ""}`.trim();
  const exitPrice = Number(exitPriceRaw);
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    throw new Error(t(language, "exitPriceInvalid"));
  }

  const position = currentState.virtualPosition;
  const entryPriceNum = Number(position.entryPrice);
  const pnlPercent = Number.isFinite(entryPriceNum) && entryPriceNum > 0
    ? ((exitPrice - entryPriceNum) / entryPriceNum) * 100
    : null;

  const exitTime = new Date();
  const entryTimeMs = position.entryTime ? Date.parse(position.entryTime) : NaN;
  const heldMinutes = Number.isFinite(entryTimeMs)
    ? Math.max(0, Math.round((exitTime.getTime() - entryTimeMs) / 60000))
    : null;

  const tradeId = createId();
  const trade = {
    id: tradeId,
    symbol: position.symbol || null,
    entryPrice: position.entryPrice,
    entryTime: position.entryTime,
    exitPrice: exitPriceRaw,
    exitTime: exitTime.toISOString(),
    pnlPercent: pnlPercent === null ? null : Number(pnlPercent.toFixed(4)),
    reason: position.reason || null,
    plannedStopLoss: position.stopLossPrice || null,
    plannedTarget: position.targetPrice || null,
    heldMinutes,
    entryAction: position.entryAction || null,
    entryConfidence: position.entryConfidence || null,
    lesson: null
  };

  const tradeHistory = [trade, ...(currentState.tradeHistory || [])].slice(0, MAX_TRADE_HISTORY);

  await patchState({
    virtualPosition: null,
    pendingLimitOrder: null,
    tradeHistory
  });

  const state = await pauseMonitoring(t(language, "sessionClosedAfterSell"));

  // Fire-and-forget lesson generation. A failure here must NOT break the flow.
  void (async () => {
    try {
      const lesson = await generateTradeLesson(trade);
      if (!lesson) return;
      const latest = await getState();
      const updatedHistory = (latest.tradeHistory || []).map((t) =>
        t.id === tradeId ? { ...t, lesson } : t
      );
      await patchState({ tradeHistory: updatedHistory });
    } catch (error) {
      console.warn("Trade lesson generation failed:", error);
    }
  })();

  return { ok: true, state };
}

// Build a fresh default state that PRESERVES the user's trade journal across a reset.
// Used anywhere we'd otherwise call saveState(createDefaultState()) — which silently
// wiped months of trade history. tradeHistory is the only field worth preserving:
// virtualPosition / pendingLimitOrder are live-trade state (not meaningful after a reset),
// monitoringProfile / results are session scoped. Callers that genuinely want a clean
// wipe (e.g. emergency reset) can still use createDefaultState() directly.
async function buildResetStatePreservingHistory(overrides = {}) {
  const prior = await getState();
  return {
    ...createDefaultState(),
    tradeHistory: Array.isArray(prior?.tradeHistory) ? prior.tradeHistory : [],
    ...overrides
  };
}

async function exitMonitoring() {
  await clearMonitoringAlarm();

  const currentState = await getState();
  const tabIds = getSessionTabIds(currentState);

  await saveState(await buildResetStatePreservingHistory());

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

  await saveState(await buildResetStatePreservingHistory({ status: STATUS.VALIDATING }));

  try {
    const capture = await captureActiveTab();
    const validation = validateStockChartByKeywordsWithLanguage({
      ...capture,
      language
    });
    const validationRecord = buildValidationRecord(validation, capture);

    if (!validation.isStockChart) {
      const state = await saveState(await buildResetStatePreservingHistory({
        lastValidation: validationRecord,
        stopReason: t(language, "validationFailedChart")
      }));

      if (capture.tabId) {
        await setSidePanelAvailabilityForTab(capture.tabId, {
          id: capture.tabId,
          title: capture.pageTitle,
          url: capture.pageUrl,
          windowId: capture.windowId
        });
      }

      await notifyUser(t(language, "notifyChartNotDetectedTitle"), t(language, "notifyChartNotDetectedBody"));

      return {
        ok: false,
        state
      };
    }

    const state = await saveState(await buildResetStatePreservingHistory({
      status: STATUS.AWAITING_CONTEXT,
      lastValidation: validationRecord
    }));

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
    const state = await saveState(await buildResetStatePreservingHistory({
      lastError: error.message,
      stopReason: t(language, "validationFailedCapture")
    }));

    await notifyUser(t(language, "notifyCaptureFailed"), error.message);

    return {
      ok: false,
      error: error.message,
      state
    };
  }
}

async function runMonitoringRound() {
  const language = await getUiLanguage();
  await abandonStaleVirtualPositionIfNeeded();
  const currentState = await getState();
  const monitoringProfile = currentState.monitoringProfile;

  if (!monitoringProfile) {
    throw new Error(t(language, "fillFormFirst"));
  }

  if (monitoringProfile.boundTabId) {
    const activeTab = await getActiveTab(monitoringProfile.boundWindowId || null).catch(() => null);

    if (!activeTab || activeTab.id !== monitoringProfile.boundTabId) {
      const state = await pauseMonitoring(t(language, "pauseLeftTab"), currentState);
      return { ok: false, state };
    }
  }

  const settings = await getSettings();
  if (settings.marketHoursOnly && !isWithinUsMarketHours()) {
    await patchState({
      ...currentState,
      status: STATUS.RUNNING,
      isRoundInFlight: false,
      stopReason: t(language, "marketClosedSkip"),
      lastError: null
    });

    return { ok: true, skipped: "market-closed" };
  }

  await patchState({
    ...currentState,
    status: STATUS.RUNNING,
    isRoundInFlight: true,
    roundStartedAt: new Date().toISOString(),
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
        stopReason: t(language, "monitoringStoppedChart"),
        lastError: null
      });

      await clearMonitoringAlarm();
      await notifyUser(t(language, "notifyMonitoringStopped"), t(language, "notifyCurrentTabNotChart"));

      return {
        ok: false,
        state
      };
    }

    const virtualPosition = currentState.virtualPosition || null;
    const nearClose = isNearUsMarketClose();
    const mode = virtualPosition
      ? (nearClose ? "force_exit" : "exit")
      : "entry";

    const recentLessons = mode === "entry"
      ? (currentState.tradeHistory || [])
          .filter((t) => t && typeof t.lesson === "string" && t.lesson.trim())
          .slice(0, 10)
          .map((t) => ({
            symbol: t.symbol,
            pnlPercent: t.pnlPercent,
            exitTime: t.exitTime,
            entryAction: t.entryAction || null,
            entryConfidence: t.entryConfidence || null,
            lesson: t.lesson
          }))
      : null;

    const lastSignal = currentState.lastResult?.analysis || null;
    const pendingLimitOrder = currentState.pendingLimitOrder || null;

    const analysis = await analyzeChartCapture({
      ...capture,
      symbolHint: monitoringProfile.symbolOverride || null,
      mode,
      virtualPosition,
      recentLessons,
      lastSignal,
      pendingLimitOrder,
      userContext: monitoringProfile.userContext || "",
      longTermContext: monitoringProfile.longTermContext || null
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

    const previousAction = currentState.lastResult?.analysis?.action ?? null;
    const actionChanged = previousAction !== analysis.action;

    if (actionChanged) {
      await notifyDiscordAnalysisResult(result, state, language);
    }
    await playResultSound();

    const totalRounds = getTotalRoundsValue(monitoringProfile.rules?.totalRounds);

    if (round >= totalRounds) {
      state = await pauseMonitoring(
        getCompletedRoundsReason(language, monitoringProfile.rules?.totalRounds),
        state
      );

      return {
        ok: true,
        state,
        result
      };
    }

    return {
      ok: true,
      state,
      result
    };
  } catch (error) {
    const state = await pauseMonitoring(
      t(language, "monitoringStoppedAnalyze"),
      currentState,
      error.message
    );

    await notifyUser(t(language, "notifyMonitoringPaused"), error.message);

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
  const baseProfile = normalizeMonitoringProfileRules(
    bindMonitoringProfileToTab(
      await buildMonitoringProfile(payload),
      activeTab
    )
  );

  // Pull the optional pre-session long-term draft into the live profile, then clear it
  // so a stale draft from a previous attempt can never leak into a future session.
  const priorState = await getState();
  const monitoringProfile = priorState.longTermContextDraft
    ? { ...baseProfile, longTermContext: priorState.longTermContextDraft }
    : baseProfile;

  await patchState({
    status: STATUS.RUNNING,
    isRoundInFlight: false,
    monitoringProfile,
    lastMonitoringProfile: monitoringProfile,
    longTermContextDraft: null,
    stopReason: null,
    lastError: null
  });

  await enableSidePanelForWindow(monitoringProfile.boundWindowId);

  scheduleMonitoringAlarm(getAnalysisIntervalMinutes(monitoringProfile.rules?.analysisInterval));

  // Kick off the first round without blocking the message response.
  // runMonitoringRound is self-contained (catches errors → pauseMonitoring).
  void runMonitoringRound();

  return {
    ok: true,
    state: await getState()
  };
}

function getResumeSession(state) {
  const language = state?.__languageForError || "en";
  const monitoringProfile = state.monitoringProfile || state.lastMonitoringProfile;

  if (!monitoringProfile) {
    throw new Error(t(language, "noPreviousSession"));
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
  const monitoringProfile = normalizeMonitoringProfileRules(savedMonitoringProfile);

  await patchState({
    status: STATUS.RUNNING,
    isRoundInFlight: false,
    monitoringProfile,
    lastMonitoringProfile: monitoringProfile,
    stopReason: null,
    lastError: null
  });

  await enableSidePanelForWindow(monitoringProfile.boundWindowId);

  scheduleMonitoringAlarm(getAnalysisIntervalMinutes(monitoringProfile.rules?.analysisInterval));

  void runMonitoringRound();

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
  const monitoringProfile = normalizeMonitoringProfileRules(savedMonitoringProfile);

  await saveState(await buildResetStatePreservingHistory({
    status: STATUS.RUNNING,
    isRoundInFlight: false,
    monitoringProfile,
    lastMonitoringProfile: monitoringProfile
  }));

  await enableSidePanelForWindow(monitoringProfile.boundWindowId);

  scheduleMonitoringAlarm(getAnalysisIntervalMinutes(monitoringProfile.rules?.analysisInterval));

  void runMonitoringRound();

  return {
    ok: true,
    state: await getState()
  };
}

// onInstalled fires on first install, version update, AND every chrome://extensions reload.
// Wiping the entire state on every reload used to nuke the trade journal — unacceptable now
// that it feeds RECENT_LESSONS and the stats card. Preserve tradeHistory only; other fields
// (virtualPosition, pendingLimitOrder, monitoringProfile, results, …) reset to defaults because
// their shape may have changed across versions and a manual reload is an explicit intervention.
chrome.runtime.onInstalled.addListener(async () => {
  await saveState(await buildResetStatePreservingHistory());
});

// Day-trading rule: positions never carry overnight. If the service worker
// resumes on a different US trading day than when the position was opened
// (user lost power / closed laptop / Chrome crashed), abandon it and log a
// placeholder trade so the user can see what happened.
async function abandonStaleVirtualPositionIfNeeded() {
  const state = await getState();
  const position = state.virtualPosition;
  if (!position) return;

  const today = getUsTradingDay();
  const positionDay = position.tradingDay
    || (position.entryTime ? getUsTradingDay(new Date(position.entryTime)) : null);
  if (!positionDay || positionDay === today) return;

  const language = await getUiLanguage();
  const trade = {
    id: createId(),
    symbol: position.symbol || null,
    entryPrice: position.entryPrice,
    entryTime: position.entryTime,
    exitPrice: null,
    exitTime: new Date().toISOString(),
    pnlPercent: null,
    reason: position.reason || null,
    plannedStopLoss: position.stopLossPrice || null,
    plannedTarget: position.targetPrice || null,
    heldMinutes: null,
    lesson: null,
    status: "abandoned",
    abandonReason: "overnight_gap"
  };
  const tradeHistory = [trade, ...(state.tradeHistory || [])].slice(0, MAX_TRADE_HISTORY);
  await patchState({ virtualPosition: null, pendingLimitOrder: null, tradeHistory });
  await pauseMonitoring(t(language, "sessionAbandonedOvernight"));
}

async function recoverMonitoringAfterStartup() {
  const state = await getState();

  if (state.status !== STATUS.RUNNING || !state.monitoringProfile) {
    return;
  }

  const boundTab = await getTabById(state.monitoringProfile.boundTabId);

  if (!boundTab) {
    await stopMonitoring(t(await getUiLanguage(), "closedTab"));
    return;
  }

  // Stale in-flight flag from a service-worker eviction during the last round.
  if (state.isRoundInFlight) {
    await patchState({ isRoundInFlight: false });
  }

  await clearMonitoringAlarm();
  scheduleMonitoringAlarm(getAnalysisIntervalMinutes(state.monitoringProfile.rules?.analysisInterval));
  await enableSidePanelForWindow(state.monitoringProfile.boundWindowId);
}

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();

  if (!state.updatedAt) {
    await saveState(createDefaultState());
  }

  await abandonStaleVirtualPositionIfNeeded();
  await recoverMonitoringAfterStartup();

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

  // Avoid re-entering a round while the previous one is still in flight.
  // Guard against a stale flag (e.g. service worker was evicted mid-round):
  // treat as stale after 3 minutes and proceed with a fresh round.
  if (state.isRoundInFlight) {
    const startedAt = state.roundStartedAt ? Date.parse(state.roundStartedAt) : 0;
    const ageMs = Date.now() - startedAt;
    if (Number.isFinite(ageMs) && ageMs < 3 * 60 * 1000) {
      return;
    }
    await patchState({ isRoundInFlight: false });
  }

  await runMonitoringRound();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await setSidePanelAvailabilityForTab(tabId);
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
    await stopMonitoring(t(await getUiLanguage(), "closedTab"));
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

    if (message?.type === "check-stale-position") {
      // Tertiary safety net for the abandon check, in addition to onStartup + runMonitoringRound.
      // Covers the edge case where Chrome stays open across trading days with no new monitoring round.
      await abandonStaleVirtualPositionIfNeeded();
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
        state: await pauseMonitoring(t(language, "stoppedByUser"))
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

    if (message?.type === "mark-bought") {
      sendResponse(await markBought(message));
      return;
    }

    if (message?.type === "mark-sold") {
      sendResponse(await markSold(message));
      return;
    }

    if (message?.type === "mark-limit-placed") {
      sendResponse(await markLimitPlaced(message));
      return;
    }

    if (message?.type === "mark-limit-cancelled") {
      sendResponse(await markLimitCancelled());
      return;
    }

    if (message?.type === "update-user-context") {
      sendResponse(await updateUserContext(message));
      return;
    }

    if (message?.type === "generate-long-term-context") {
      sendResponse(await generateLongTermContextHandler(message));
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


