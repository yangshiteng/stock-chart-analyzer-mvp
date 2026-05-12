import {
  ALARM_NAME,
  ANALYSIS_INTERVAL_OPTIONS,
  DEFAULT_ANALYSIS_INTERVAL,
  MAX_RESULTS,
  MAX_TRADE_HISTORY,
  STATUS,
  createDefaultState
} from "./lib/constants.js";
import {
  getActiveAnalysisIntervalRule,
  isValidAnalysisInterval,
  normalizeAnalysisInterval,
  normalizeAnalysisIntervalRules
} from "./lib/analysis-intervals.js";
import { validateChartTab } from "./lib/chart-validator.js";
import { getDiscordNotificationReason } from "./lib/discord-signal.js";
import { getLanguage, t } from "./lib/i18n.js";
import {
  analyzeChartCapture,
  analyzeMarketContextScan,
  generatePremarketDipPlan,
  generateTradeLesson
} from "./lib/llm.js";
import {
  MARKET_CONTEXT_STATUS,
  createDefaultMarketContext,
  createMarketContextForProfile,
  isMarketContextValidForProfile,
  mergeMarketContextScans,
  normalizeMarketContext,
  shouldPreserveMarketContextAcrossReset
} from "./lib/market-context.js";
import { getUsMarketSessionPhase, getUsTradingDay, isNearUsMarketClose } from "./lib/market-hours.js";
import {
  buildPendingLimitOrderFromPremarketPlan,
  isWithinPremarketDipWindow,
  normalizePositiveDecimal
} from "./lib/premarket-dip.js";
import {
  buildSellStrategyContext,
  isValidSellDelta,
  normalizeSellDelta,
  normalizeSellStrategyRules
} from "./lib/sell-strategy.js";
import {
  SIDEPANEL_PATH,
  enableSidePanelForWindow,
  resetSidePanelDefaultsToFullUi,
  setSidePanelAvailabilityForTab
} from "./lib/side-panel.js";
import { getSettings, getState, patchState, saveState } from "./lib/storage.js";

const ICON_PATH = "assets/icon-128.png";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const ANALYSIS_INTERVAL_MINUTES = new Map(ANALYSIS_INTERVAL_OPTIONS.map((option) => [option.value, option.minutes]));
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


function buildDiscordAnalysisPayloadV4(result, state, language, notificationReason = null) {
  const analysis = result?.analysis || {};
  const fallback = getSafeDiscordFallback(language);
  const symbol = analysis.symbol || result?.validation?.symbolGuess || fallback;
  const description = truncateText(
    analysis.reasoning
      || (language === "zh" ? "新的图表分析结果已经生成。" : "A new chart analysis result is ready."),
    350
  );
  const updateFields = notificationReason
    ? [
        {
          name: t(language, "discordUpdateReasonLabel"),
          value: truncateText(t(language, `discordUpdateReason_${notificationReason}`), 120),
          inline: false
        }
      ]
    : [];

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
          ...updateFields,
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
            name: t(language, "orderPriceLabel"),
            value: truncateText(analysis.orderPrice || fallback, 120),
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

async function notifyDiscordAnalysisResult(result, state, language, notificationReason = null) {
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
      body: JSON.stringify(buildDiscordAnalysisPayloadV4(result, state, language, notificationReason))
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

function rebindProfileWindow(profile, tab) {
  if (!profile || !tab || profile.boundTabId !== tab.id) {
    return profile;
  }

  const nextWindowId = tab.windowId ?? profile.boundWindowId ?? null;
  const nextTitle = tab.title || profile.boundTabTitle || "";
  const nextUrl = tab.url || profile.boundTabUrl || "";
  if (
    profile.boundWindowId === nextWindowId
    && profile.boundTabTitle === nextTitle
    && profile.boundTabUrl === nextUrl
  ) {
    return profile;
  }

  return {
    ...profile,
    boundWindowId: nextWindowId,
    boundTabTitle: nextTitle,
    boundTabUrl: nextUrl
  };
}

async function syncBoundTabWindowIfNeeded(currentState = null) {
  const state = currentState || await getState();
  const monitoringProfile = state.monitoringProfile || null;
  const lastMonitoringProfile = state.lastMonitoringProfile || null;
  const boundTabId = monitoringProfile?.boundTabId || lastMonitoringProfile?.boundTabId || null;

  if (!boundTabId) {
    return state;
  }

  const boundTab = await getTabById(boundTabId);
  if (!boundTab) {
    return state;
  }

  const nextMonitoringProfile = rebindProfileWindow(monitoringProfile, boundTab);
  const nextLastMonitoringProfile = rebindProfileWindow(lastMonitoringProfile, boundTab);
  const changed = nextMonitoringProfile !== monitoringProfile
    || nextLastMonitoringProfile !== lastMonitoringProfile
    || state.lastValidation?.tabId === boundTab.id && state.lastValidation?.windowId !== boundTab.windowId;

  if (!changed) {
    return state;
  }

  return patchState({
    monitoringProfile: nextMonitoringProfile,
    lastMonitoringProfile: nextLastMonitoringProfile,
    lastValidation: state.lastValidation?.tabId === boundTab.id
      ? {
          ...state.lastValidation,
          windowId: boundTab.windowId,
          pageTitle: boundTab.title || state.lastValidation.pageTitle || "",
          pageUrl: boundTab.url || state.lastValidation.pageUrl || ""
        }
      : state.lastValidation
  });
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
  const syncedState = await syncBoundTabWindowIfNeeded();
  const syncedProfile = syncedState.monitoringProfile || syncedState.lastMonitoringProfile || monitoringProfile;
  const boundTab = await getTabById(syncedProfile?.boundTabId);

  if (!boundTab) {
    throw new Error(t(language, "resumeTabMissing"));
  }

  const activeTab = await getActiveTab(boundTab.windowId || syncedProfile?.boundWindowId || null);

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

function normalizeMonitoringProfileRules(monitoringProfile) {
  if (!monitoringProfile) {
    return null;
  }

  const {
    analysisInterval,
    entryInterval,
    pendingInterval,
    positionInterval,
    quickProfitDelta,
    maxLossDelta,
    totalRounds,
    ...restRules
  } = monitoringProfile.rules || {};
  void analysisInterval;
  void entryInterval;
  void pendingInterval;
  void positionInterval;
  void quickProfitDelta;
  void maxLossDelta;
  void totalRounds;
  return {
    ...monitoringProfile,
    rules: {
      ...restRules,
      ...normalizeAnalysisIntervalRules(monitoringProfile.rules),
      ...normalizeSellStrategyRules(monitoringProfile.rules)
    }
  };
}

function getActiveIntervalRuleForState(state, monitoringProfile = null) {
  const profile = monitoringProfile || state.monitoringProfile || state.lastMonitoringProfile || null;
  return getActiveAnalysisIntervalRule(state, profile?.rules || {});
}

function scheduleMonitoringAlarmForState(state, monitoringProfile = null) {
  scheduleMonitoringAlarm(getAnalysisIntervalMinutes(getActiveIntervalRuleForState(state, monitoringProfile)));
}

function getSellStrategyForState(state, monitoringProfile = null) {
  const profile = monitoringProfile || state.monitoringProfile || state.lastMonitoringProfile || null;
  return buildSellStrategyContext(state.virtualPosition, profile?.rules || {});
}

async function rescheduleMonitoringAlarmIfRunning(state) {
  if (state?.status !== STATUS.RUNNING) {
    return;
  }

  scheduleMonitoringAlarmForState(state);
}

function getMarketContextForProfile(state, monitoringProfile) {
  const current = normalizeMarketContext(state.marketContext);
  if (isMarketContextValidForProfile(current, monitoringProfile)) {
    return current;
  }

  if (
    current.symbol === `${monitoringProfile?.symbolOverride || ""}`.trim().toUpperCase()
    && current.tradingDay === getUsTradingDay()
  ) {
    return current;
  }

  return createMarketContextForProfile(monitoringProfile);
}

async function setAwaitingMarketContext(monitoringProfile, currentState, reason = null, overrides = {}) {
  await clearMonitoringAlarm();

  const marketContext = getMarketContextForProfile(currentState, monitoringProfile);
  const state = await patchState({
    status: STATUS.AWAITING_CONTEXT,
    isRoundInFlight: false,
    roundStartedAt: null,
    monitoringProfile,
    lastMonitoringProfile: monitoringProfile,
    marketContext,
    premarketDipPlan: null,

    stopReason: reason,
    lastError: null,
    ...overrides
  });

  await enableSidePanelForWindow(monitoringProfile.boundWindowId);
  return state;
}

async function beginMonitoringRounds(monitoringProfile, currentState, overrides = {}) {
  const state = await patchState({
    status: STATUS.RUNNING,
    isRoundInFlight: false,
    roundStartedAt: null,
    monitoringProfile,
    lastMonitoringProfile: monitoringProfile,
    marketContext: normalizeMarketContext(currentState.marketContext),
    premarketDipPlan: currentState.pendingLimitOrder?.source === "premarket_dip_plan"
      ? currentState.premarketDipPlan
      : null,

    stopReason: null,
    lastError: null,
    ...overrides
  });

  await enableSidePanelForWindow(monitoringProfile.boundWindowId);

  scheduleMonitoringAlarmForState(state, monitoringProfile);
  void runMonitoringRound();

  return state;
}

function getAnalysisIntervalLabel(language, rule) {
  return t(language, `analysisInterval_${normalizeAnalysisInterval(rule)}`);
}

async function buildMonitoringProfile(payload) {
  const language = await getUiLanguage();
  const symbolOverride = `${payload.symbolOverride || ""}`.trim().toUpperCase().slice(0, 10) || null;

  if (!symbolOverride) {
    throw new Error(t(language, "symbolRequired"));
  }

  const entryInterval = `${payload.entryInterval || payload.analysisInterval || "5m"}`.trim();
  const pendingInterval = `${payload.pendingInterval || "2m"}`.trim();
  const positionInterval = `${payload.positionInterval || "1m"}`.trim();
  const quickProfitDeltaRaw = `${payload.quickProfitDelta || "0.20"}`.trim();
  const maxLossDeltaRaw = `${payload.maxLossDelta || "0.30"}`.trim();

  if (
    !isValidAnalysisInterval(entryInterval)
    || !isValidAnalysisInterval(pendingInterval)
    || !isValidAnalysisInterval(positionInterval)
  ) {
    throw new Error(t(language, "chooseValidAnalysisInterval"));
  }

  if (!isValidSellDelta(quickProfitDeltaRaw) || !isValidSellDelta(maxLossDeltaRaw)) {
    throw new Error(t(language, "chooseValidSellStrategy"));
  }

  const quickProfitDelta = normalizeSellDelta(quickProfitDeltaRaw, "0.20");
  const maxLossDelta = normalizeSellDelta(maxLossDeltaRaw, "0.30");

  return {
    symbolOverride,
    rules: {
      entryInterval,
      pendingInterval,
      positionInterval,
      quickProfitDelta,
      maxLossDelta
    }
  };
}

function getCurrentAnalysisMode(state) {
  if (!state.virtualPosition) {
    return "entry";
  }

  return isNearUsMarketClose() ? "force_exit" : "exit";
}

async function markBought(payload) {
  const language = await getUiLanguage();
  const currentState = await getState();
  const pending = currentState.pendingLimitOrder;
  const isPremarketAwaitingFill = currentState.status === STATUS.AWAITING_CONTEXT
    && pending?.source === "premarket_dip_plan"
    && pending?.action === "BUY_LIMIT";
  if (currentState.status !== STATUS.RUNNING && !isPremarketAwaitingFill) {
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
  const suggestion = currentState.lastResult?.analysis || {};
  const source = pending || suggestion;
  const now = new Date();
  const virtualPosition = {
    entryPrice: entryPriceRaw,
    entryTime: now.toISOString(),
    tradingDay: getUsTradingDay(now),
    stopLossPrice: source.stopLossPrice || suggestion.stopLossPrice || null,
    targetPrice: source.targetPrice || suggestion.targetPrice || null,
    reason: source.reasoning || source.reason || suggestion.reasoning || null,
    symbol: currentState.monitoringProfile?.symbolOverride || source.symbol || suggestion.symbol || null,
    sourceRound: pending?.sourceRound ?? currentState.roundCount ?? 0,
    source: pending?.source || "signal",
    sourceReviewId: pending?.sourceReviewId || null,
    entryAction: pending?.action || suggestion.action || null,
    entryConfidence: pending?.confidence || suggestion.confidence || null
  };

  const state = await patchState({
    virtualPosition,
    pendingLimitOrder: null,

    lastError: null
  });
  await rescheduleMonitoringAlarmIfRunning(state);
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

  const limitPriceRaw = `${payload?.limitPrice ?? suggestion.orderPrice ?? ""}`.trim();
  const limitPrice = Number(limitPriceRaw);
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
    throw new Error(t(language, "limitPriceInvalid"));
  }

  const pendingLimitOrder = {
    action,
    limitPrice: limitPriceRaw,
    stopLossPrice: suggestion.stopLossPrice || null,
    targetPrice: suggestion.targetPrice || null,
    reasoning: suggestion.reasoning || null,
    confidence: suggestion.confidence || null,
    symbol: currentState.monitoringProfile?.symbolOverride || suggestion.symbol || null,
    placedAt: new Date().toISOString(),
    sourceRound: currentState.roundCount || 0
  };

  const state = await patchState({ pendingLimitOrder, lastError: null });
  await rescheduleMonitoringAlarmIfRunning(state);
  return { ok: true, state };
}

async function markLimitCancelled() {
  const currentState = await getState();
  if (!currentState.pendingLimitOrder) {
    // Idempotent — already no pending. Not an error.
    return { ok: true, state: currentState };
  }
  const state = await patchState({ pendingLimitOrder: null });
  await rescheduleMonitoringAlarmIfRunning(state);
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

// Build a fresh default state that preserves the user's trade journal across a reset.
// Session-scoped tracking state is intentionally cleared; the broker account is
// the source of truth for any real position/order.
async function buildResetStatePreservingHistory(overrides = {}) {
  const prior = await getState();

  // Preserve same-day completed marketContext across resets — it's expensive
  // (~$0.10 + ~30s of UX per session) to re-scan, and structural Daily / 1H
  // context does not change intraday. Trading-day mismatch wipes it (correct:
  // yesterday's structure is irrelevant). Symbol mismatch is checked at
  // consume-time by isMarketContextValidForProfile, which compares against
  // the new profile's symbolOverride and forces a re-scan if different.
  // Caller can still pass `marketContext: createDefaultMarketContext()` in
  // overrides to force a wipe (none currently need to).
  const preservedContext = shouldPreserveMarketContextAcrossReset(prior?.marketContext)
    ? normalizeMarketContext(prior.marketContext)
    : createDefaultMarketContext();

  return {
    ...createDefaultState(),
    tradeHistory: Array.isArray(prior?.tradeHistory) ? prior.tradeHistory : [],
    marketContext: preservedContext,
    ...overrides
  };
}

async function exitMonitoring(reason = null) {
  await clearMonitoringAlarm();

  const currentState = await getState();
  const tabIds = getSessionTabIds(currentState);

  await saveState(await buildResetStatePreservingHistory({
    stopReason: reason,
    lastError: null
  }));

  // Reset the GLOBAL default panel path back to sidepanel.html. While a
  // session was live, enableSidePanelForWindow set the default to the "switch
  // to monitored tab" placeholder; without resetting it here, any new tab
  // opened post-Exit would still render the placeholder pointing at a stale
  // boundTabId.
  await resetSidePanelDefaultsToFullUi();

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
    const validation = validateChartTab({
      ...capture,
      language
    });
    const validationRecord = buildValidationRecord(validation, capture);

    if (!validation.isTradingView) {
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
      // Set the validated tab's per-tab override first so the panel that's
      // about to open shows sidepanel.html (the form), not the placeholder.
      await setSidePanelAvailabilityForTab(capture.tabId, {
        id: capture.tabId,
        title: capture.pageTitle,
        url: capture.pageUrl,
        windowId: capture.windowId
      });

      // Then install the placeholder as global default + per-tab override on
      // every OTHER tab in the window. Without this, the user's first switch
      // away from the validated tab still renders the manifest default
      // (sidepanel.html) — Chrome looks up the new tab's options on
      // activation, falls back to the global default, renders the form, and
      // by the time our async onActivated handler calls setOptions the panel
      // is already on screen and won't refresh until the user switches away
      // and back. Pre-setting closes that race.
      if (capture.windowId) {
        await enableSidePanelForWindow(capture.windowId);
      }
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
  const currentState = await syncBoundTabWindowIfNeeded();
  const monitoringProfile = currentState.monitoringProfile;

  if (!monitoringProfile) {
    throw new Error(t(language, "fillFormFirst"));
  }

  if (!isMarketContextValidForProfile(currentState.marketContext, monitoringProfile)) {
    const state = await setAwaitingMarketContext(
      monitoringProfile,
      currentState,
      t(language, "marketContextRequired")
    );
    return { ok: false, error: t(language, "marketContextRequired"), state };
  }

  if (monitoringProfile.boundTabId) {
    const boundTab = await getTabById(monitoringProfile.boundTabId);
    const activeTab = await getActiveTab(boundTab?.windowId || monitoringProfile.boundWindowId || null).catch(() => null);

    if (!activeTab || activeTab.id !== monitoringProfile.boundTabId) {
      const state = await pauseMonitoring(t(language, "pauseLeftTab"), currentState);
      return { ok: false, state };
    }
  }

  const marketSessionPhase = getUsMarketSessionPhase();
  if (marketSessionPhase !== "open") {
    if (marketSessionPhase === "before_open") {
      const state = await patchState({
        ...currentState,
        status: STATUS.RUNNING,
        isRoundInFlight: false,
        stopReason: t(language, "marketBeforeOpenSkip"),
        lastError: null
      });
      scheduleMonitoringAlarmForState(state, monitoringProfile);

      return { ok: true, state, skipped: "before-open" };
    }

    const state = await pauseMonitoring(t(language, "marketClosedPause"), currentState);
    return { ok: true, state, skipped: "market-closed" };
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
    const validation = validateChartTab({
      ...capture,
      language
    });
    const validationRecord = buildValidationRecord(validation, capture);

    if (!validation.isTradingView) {
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

    const lastSignal = currentState.lastResult?.analysis || null;
    const pendingLimitOrder = currentState.pendingLimitOrder || null;

    const analysis = await analyzeChartCapture({
      ...capture,
      symbolHint: monitoringProfile.symbolOverride || null,
      mode,
      virtualPosition,
      sellStrategy: getSellStrategyForState(currentState, monitoringProfile),
      lastSignal,
      pendingLimitOrder,
      marketContext: currentState.marketContext?.summary || null
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

    const notificationReason = getDiscordNotificationReason(
      currentState.lastResult?.analysis || null,
      analysis
    );

    if (notificationReason) {
      await notifyDiscordAnalysisResult(result, state, language, notificationReason);
    }
    await playResultSound();

    scheduleMonitoringAlarmForState(state, monitoringProfile);

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

function getMarketContextSetupProfile(state, language) {
  const monitoringProfile = normalizeMonitoringProfileRules(state.monitoringProfile || state.lastMonitoringProfile);
  if (!monitoringProfile) {
    throw new Error(t(language, "fillFormFirst"));
  }
  return monitoringProfile;
}

async function scanMarketContext(payload) {
  await ensureApiKeyConfigured();

  const language = await getUiLanguage();
  const currentState = await getState();
  const monitoringProfile = getMarketContextSetupProfile(currentState, language);
  const timeframe = payload?.timeframe === "1h" ? "1h" : "daily";

  if (timeframe === "1h") {
    const currentContext = getMarketContextForProfile(currentState, monitoringProfile);
    if (!currentContext.dailyScan) {
      throw new Error(t(language, "marketContextDailyRequired"));
    }
  }

  await ensureMonitoringTabActive(monitoringProfile, language);

  try {
    const capture = await captureActiveTab(monitoringProfile.boundWindowId || null);
    const validation = validateChartTab({
      ...capture,
      language
    });
    const validationRecord = buildValidationRecord(validation, capture);

    if (!validation.isTradingView) {
      const state = await patchState({
        status: STATUS.AWAITING_CONTEXT,
        isRoundInFlight: false,
        monitoringProfile,
        lastMonitoringProfile: monitoringProfile,
        lastValidation: validationRecord,
        lastError: t(language, "validationFailedChart")
      });
      return { ok: false, error: t(language, "validationFailedChart"), state };
    }

    const scan = await analyzeMarketContextScan({
      ...capture,
      timeframe,
      symbolHint: monitoringProfile.symbolOverride || null
    });
    const scanRecord = {
      ...scan,
      capturedAt: new Date().toISOString(),
      pageTitle: capture.pageTitle,
      pageUrl: capture.pageUrl
    };
    const baseContext = getMarketContextForProfile(currentState, monitoringProfile);
    const symbol = monitoringProfile.symbolOverride || baseContext.symbol || null;
    const tradingDay = baseContext.tradingDay || getUsTradingDay();

    const marketContext = timeframe === "daily"
      ? {
          ...baseContext,
          status: MARKET_CONTEXT_STATUS.DAILY_SCANNED,
          symbol,
          tradingDay,
          dailyScan: scanRecord,
          hourlyScan: null,
          summary: null,
          lastError: null,
          updatedAt: new Date().toISOString()
        }
      : mergeMarketContextScans({
          dailyScan: baseContext.dailyScan,
          hourlyScan: scanRecord,
          symbol,
          tradingDay
        });

    const state = await patchState({
      status: STATUS.AWAITING_CONTEXT,
      isRoundInFlight: false,
      roundStartedAt: null,
      monitoringProfile,
      lastMonitoringProfile: monitoringProfile,
      lastValidation: validationRecord,
      marketContext,
      premarketDipPlan: null,
      stopReason: null,
      lastError: null
    });

    return { ok: true, state, marketContext };
  } catch (error) {
    const marketContext = {
      ...getMarketContextForProfile(currentState, monitoringProfile),
      lastError: error.message,
      updatedAt: new Date().toISOString()
    };
    const state = await patchState({
      status: STATUS.AWAITING_CONTEXT,
      isRoundInFlight: false,
      monitoringProfile,
      lastMonitoringProfile: monitoringProfile,
      marketContext,
      lastError: error.message
    });
    return { ok: false, error: error.message, state };
  }
}

function buildInitialVirtualPositionFromPayload(payload, monitoringProfile, language) {
  if (payload?.initialPositionMode !== "holding") {
    return null;
  }

  const entryPriceRaw = `${payload?.initialEntryPrice || ""}`.trim();
  const entryPrice = Number(entryPriceRaw);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error(t(language, "initialEntryPriceInvalid"));
  }

  const now = new Date();
  return {
    entryPrice: entryPriceRaw,
    entryTime: now.toISOString(),
    tradingDay: getUsTradingDay(now),
    stopLossPrice: null,
    targetPrice: null,
    reason: "User declared an existing broker position before monitoring started.",
    symbol: monitoringProfile.symbolOverride || null,
    sourceRound: 0,
    source: "manual_existing_position",
    sourceReviewId: null,
    entryAction: "manual_existing_position",
    entryConfidence: null
  };
}

async function confirmMarketContextAndStart(payload = {}) {
  await ensureApiKeyConfigured();

  const language = await getUiLanguage();
  const currentState = await getState();
  const monitoringProfile = getMarketContextSetupProfile(currentState, language);

  await ensureMonitoringTabActive(monitoringProfile, language);

  if (!isMarketContextValidForProfile(currentState.marketContext, monitoringProfile)) {
    const state = await setAwaitingMarketContext(
      monitoringProfile,
      currentState,
      t(language, "marketContextRequired")
    );
    return { ok: false, error: t(language, "marketContextNotComplete"), state };
  }

  const initialVirtualPosition = buildInitialVirtualPositionFromPayload(payload, monitoringProfile, language);
  const state = await beginMonitoringRounds(
    monitoringProfile,
    currentState,
    initialVirtualPosition
      ? {
          virtualPosition: initialVirtualPosition,
          pendingLimitOrder: null,
          premarketDipPlan: null
        }
      : {}
  );
  return { ok: true, state };
}

async function createPremarketDipPlan(payload) {
  await ensureApiKeyConfigured();

  const language = await getUiLanguage();
  const currentState = await getState();
  const monitoringProfile = getMarketContextSetupProfile(currentState, language);

  if (currentState.status !== STATUS.AWAITING_CONTEXT) {
    throw new Error(t(language, "premarketDipSetupOnly"));
  }
  if (currentState.virtualPosition) {
    throw new Error(t(language, "limitBuyWhileHolding"));
  }
  if (currentState.pendingLimitOrder) {
    throw new Error(t(language, "limitAlreadyPending"));
  }
  if (!isWithinPremarketDipWindow()) {
    throw new Error(t(language, "premarketDipUnavailable"));
  }
  if (!isMarketContextValidForProfile(currentState.marketContext, monitoringProfile)) {
    throw new Error(t(language, "marketContextNotComplete"));
  }

  let referenceClose;
  try {
    referenceClose = normalizePositiveDecimal(payload?.referenceClose, "referenceClose");
  } catch {
    throw new Error(t(language, "premarketReferenceCloseInvalid"));
  }

  const plan = await generatePremarketDipPlan({
    symbol: monitoringProfile.symbolOverride,
    referenceClose,
    marketContext: currentState.marketContext
  });
  const now = new Date();
  const premarketDipPlan = {
    ...plan,
    id: createId(),
    status: "draft",
    source: "premarket_dip_plan",
    symbol: monitoringProfile.symbolOverride,
    referenceClose,
    tradingDay: getUsTradingDay(now),
    createdAt: now.toISOString()
  };

  const state = await patchState({
    premarketDipPlan,
    lastError: null
  });

  return { ok: true, state, plan: premarketDipPlan };
}

async function adoptPremarketDipPlan() {
  const language = await getUiLanguage();
  const currentState = await getState();
  const monitoringProfile = getMarketContextSetupProfile(currentState, language);
  const plan = currentState.premarketDipPlan;

  if (currentState.status !== STATUS.AWAITING_CONTEXT) {
    throw new Error(t(language, "premarketDipSetupOnly"));
  }
  if (!plan) {
    throw new Error(t(language, "premarketNoPlan"));
  }
  if (currentState.virtualPosition) {
    throw new Error(t(language, "limitBuyWhileHolding"));
  }
  if (currentState.pendingLimitOrder) {
    throw new Error(t(language, "limitAlreadyPending"));
  }
  if (!isWithinPremarketDipWindow()) {
    throw new Error(t(language, "premarketDipUnavailable"));
  }
  if (!isMarketContextValidForProfile(currentState.marketContext, monitoringProfile)) {
    throw new Error(t(language, "marketContextNotComplete"));
  }

  const now = new Date();
  const pendingLimitOrder = buildPendingLimitOrderFromPremarketPlan(plan, {
    now,
    sourceRound: currentState.roundCount || 0,
    sourcePlanId: plan.id || null,
    symbol: monitoringProfile.symbolOverride
  });

  const state = await patchState({
    pendingLimitOrder,
    premarketDipPlan: {
      ...plan,
      status: "accepted",
      acceptedAt: now.toISOString()
    },

    lastError: null
  });

  return { ok: true, state, pendingLimitOrder };
}

async function startMonitoring(payload) {
  await ensureApiKeyConfigured();
  await clearMonitoringAlarm();

  const activeTab = await getActiveTab();
  const baseProfile = normalizeMonitoringProfileRules(
    bindMonitoringProfileToTab(
      await buildMonitoringProfile(payload),
      activeTab
    )
  );
  const currentState = await getState();
  // Preserve a still-valid Market Context Scan across the form submission.
  // Without this, every Start Monitoring click wipes the scan even when the
  // user just scanned moments earlier — directly contradicting the
  // shouldPreserveMarketContextAcrossReset preservation in
  // buildResetStatePreservingHistory(). isMarketContextValidForProfile gates
  // on COMPLETE status + same ticker + same trading day, so cross-day or
  // ticker-change submissions still get a fresh blank context as before.
  const marketContext = isMarketContextValidForProfile(currentState.marketContext, baseProfile)
    ? currentState.marketContext
    : createMarketContextForProfile(baseProfile);

  const state = await patchState({
    status: STATUS.AWAITING_CONTEXT,
    isRoundInFlight: false,
    roundStartedAt: null,
    monitoringProfile: baseProfile,
    lastMonitoringProfile: baseProfile,
    roundCount: 0,
    lastResult: null,

    marketContext,
    results: [],
    virtualPosition: null,
    pendingLimitOrder: null,
    premarketDipPlan: null,
    stopReason: null,
    lastError: null,
    tradeHistory: currentState.tradeHistory || []
  });

  await enableSidePanelForWindow(baseProfile.boundWindowId);

  return {
    ok: true,
    state
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
  const syncedState = await getState();
  const monitoringProfile = normalizeMonitoringProfileRules(
    syncedState.monitoringProfile || syncedState.lastMonitoringProfile || savedMonitoringProfile
  );

  const state = isMarketContextValidForProfile(syncedState.marketContext, monitoringProfile)
    ? await beginMonitoringRounds(monitoringProfile, syncedState)
    : await setAwaitingMarketContext(
        monitoringProfile,
        syncedState,
        t(language, "marketContextRequired")
      );

  return {
    ok: true,
    state
  };
}

function updateProfileAnalysisIntervals(profile, intervalRules) {
  if (!profile) {
    return null;
  }

  const { analysisInterval, entryInterval, pendingInterval, positionInterval, totalRounds, ...restRules } = profile.rules || {};
  void analysisInterval;
  void entryInterval;
  void pendingInterval;
  void positionInterval;
  void totalRounds;
  return {
    ...profile,
    rules: {
      ...restRules,
      ...intervalRules
    }
  };
}

async function updateAnalysisIntervals(payload) {
  const language = await getUiLanguage();
  const currentState = await getState();
  const profile = currentState.monitoringProfile || currentState.lastMonitoringProfile;

  if (!profile) {
    throw new Error(t(language, "noPreviousSession"));
  }

  const entryInterval = `${payload?.entryInterval || ""}`.trim();
  const pendingInterval = `${payload?.pendingInterval || ""}`.trim();
  const positionInterval = `${payload?.positionInterval || ""}`.trim();

  if (
    !isValidAnalysisInterval(entryInterval)
    || !isValidAnalysisInterval(pendingInterval)
    || !isValidAnalysisInterval(positionInterval)
  ) {
    throw new Error(t(language, "chooseValidAnalysisInterval"));
  }

  const intervalRules = { entryInterval, pendingInterval, positionInterval };
  const state = await patchState({
    monitoringProfile: updateProfileAnalysisIntervals(currentState.monitoringProfile, intervalRules),
    lastMonitoringProfile: updateProfileAnalysisIntervals(currentState.lastMonitoringProfile || profile, intervalRules),
    lastError: null
  });

  await rescheduleMonitoringAlarmIfRunning(state);

  return { ok: true, state };
}

function updateProfileSellStrategy(profile, sellRules) {
  if (!profile) {
    return null;
  }

  const { quickProfitDelta, maxLossDelta, ...restRules } = profile.rules || {};
  void quickProfitDelta;
  void maxLossDelta;
  return {
    ...profile,
    rules: {
      ...restRules,
      ...sellRules
    }
  };
}

async function updateSellStrategy(payload) {
  const language = await getUiLanguage();
  const currentState = await getState();
  const profile = currentState.monitoringProfile || currentState.lastMonitoringProfile;

  if (!profile) {
    throw new Error(t(language, "noPreviousSession"));
  }

  const quickProfitDeltaRaw = `${payload?.quickProfitDelta || ""}`.trim();
  const maxLossDeltaRaw = `${payload?.maxLossDelta || ""}`.trim();

  if (!isValidSellDelta(quickProfitDeltaRaw) || !isValidSellDelta(maxLossDeltaRaw)) {
    throw new Error(t(language, "chooseValidSellStrategy"));
  }

  const sellRules = {
    quickProfitDelta: normalizeSellDelta(quickProfitDeltaRaw, "0.20"),
    maxLossDelta: normalizeSellDelta(maxLossDeltaRaw, "0.30")
  };
  const state = await patchState({
    monitoringProfile: updateProfileSellStrategy(currentState.monitoringProfile, sellRules),
    lastMonitoringProfile: updateProfileSellStrategy(currentState.lastMonitoringProfile || profile, sellRules),
    lastError: null
  });

  return { ok: true, state };
}

// onInstalled fires on first install, version update, AND every chrome://extensions reload.
// Wiping the entire state on every reload used to nuke the trade journal — unacceptable now
// that it feeds human review and the stats card. Preserve tradeHistory only; other fields
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

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();

  if (!state.updatedAt) {
    await saveState(createDefaultState());
  } else if (
    state.status !== STATUS.IDLE
    || state.virtualPosition
    || state.pendingLimitOrder
    || state.monitoringProfile
    || state.lastMonitoringProfile
  ) {
    await clearMonitoringAlarm();
    await saveState(await buildResetStatePreservingHistory());
    await resetSidePanelDefaultsToFullUi();
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

// New tabs (Ctrl+T, link in new tab, etc.) need their per-tab side-panel path
// set BEFORE Chrome falls back to the manifest default (sidepanel.html).
// Without this, opening a new tab during a live session briefly shows the
// full UI instead of the "switch back" placeholder, and Chrome doesn't
// always re-render the panel after a delayed setOptions on the active tab.
// onCreated fires synchronously when the tab is created, before activation,
// giving us a tight window to install the right path first.
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab?.id) return;
  await setSidePanelAvailabilityForTab(tab.id, tab);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title && changeInfo.status !== "complete") {
    return;
  }

  await setSidePanelAvailabilityForTab(tabId, tab);
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  const state = await getState();
  const monitoringProfile = state.monitoringProfile || null;
  const lastMonitoringProfile = state.lastMonitoringProfile || null;
  const boundTabId = monitoringProfile?.boundTabId || lastMonitoringProfile?.boundTabId || null;

  if (!boundTabId || tabId !== boundTabId) {
    return;
  }

  const tab = await getTabById(tabId);
  const fallbackTab = tab || {
    id: tabId,
    windowId: attachInfo?.newWindowId ?? monitoringProfile?.boundWindowId ?? lastMonitoringProfile?.boundWindowId ?? null
  };
  const nextMonitoringProfile = rebindProfileWindow(monitoringProfile, fallbackTab);
  const nextLastMonitoringProfile = rebindProfileWindow(lastMonitoringProfile, fallbackTab);
  const nextLastValidation = state.lastValidation?.tabId === tabId
    ? {
        ...state.lastValidation,
        windowId: fallbackTab.windowId,
        pageTitle: fallbackTab.title || state.lastValidation.pageTitle || "",
        pageUrl: fallbackTab.url || state.lastValidation.pageUrl || ""
      }
    : state.lastValidation;
  const nextState = await patchState({
    monitoringProfile: nextMonitoringProfile,
    lastMonitoringProfile: nextLastMonitoringProfile,
    lastValidation: nextLastValidation
  });
  const windowId = fallbackTab.windowId || nextState.monitoringProfile?.boundWindowId || nextState.lastMonitoringProfile?.boundWindowId;
  await enableSidePanelForWindow(windowId);
  await setSidePanelAvailabilityForTab(tabId, fallbackTab);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  const monitoringProfile = state.monitoringProfile || state.lastMonitoringProfile;

  if (!monitoringProfile?.boundTabId || tabId !== monitoringProfile.boundTabId) {
    return;
  }

  if (state.status !== STATUS.IDLE || state.virtualPosition || state.pendingLimitOrder) {
    await exitMonitoring(t(await getUiLanguage(), "closedTab"));
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
      // Secondary safety net for the abandon check, in addition to runMonitoringRound.
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

    if (message?.type === "scan-market-context") {
      sendResponse(await scanMarketContext(message));
      return;
    }

    if (message?.type === "confirm-market-context") {
      sendResponse(await confirmMarketContextAndStart(message));
      return;
    }

    if (message?.type === "generate-premarket-dip-plan") {
      sendResponse(await createPremarketDipPlan(message));
      return;
    }

    if (message?.type === "adopt-premarket-dip-plan") {
      sendResponse(await adoptPremarketDipPlan());
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

    if (message?.type === "update-analysis-intervals") {
      sendResponse(await updateAnalysisIntervals(message));
      return;
    }

    if (message?.type === "update-sell-strategy") {
      sendResponse(await updateSellStrategy(message));
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


