import { ANALYSIS_INTERVAL_OPTIONS, STATUS } from "./lib/constants.js";
import {
  getActiveAnalysisIntervalRule,
  getAnalysisPhase,
  getIntervalRecommendationKey,
  normalizeAnalysisInterval,
  normalizeAnalysisIntervalRules
} from "./lib/analysis-intervals.js";
import { getLanguage, t } from "./lib/i18n.js";
import { MARKET_CONTEXT_STATUS } from "./lib/market-context.js";
import {
  buildSellStrategyContext,
  normalizeSellDelta,
  normalizeSellStrategyRules
} from "./lib/sell-strategy.js";
import { getSettings, getState, patchSettings } from "./lib/storage.js";
import { computeTradeStats } from "./lib/trade-stats.js";

const heroEyebrow = document.getElementById("heroEyebrow");
const heroTitle = document.getElementById("heroTitle");
const statusBadge = document.getElementById("statusBadge");
const summaryText = document.getElementById("summaryText");
const apiSetupSection = document.getElementById("apiSetupSection");
const stopMonitorButton = document.getElementById("stopMonitorButton");
const continueMonitorButton = document.getElementById("continueMonitorButton");
const exitMonitorButton = document.getElementById("exitMonitorButton");
const apiSetupTitle = document.getElementById("apiSetupTitle");
const apiSetupCopy = document.getElementById("apiSetupCopy");
const apiKeyLabel = document.getElementById("apiKeyLabel");
const apiKeyInput = document.getElementById("apiKeyInput");
const saveApiKeyButton = document.getElementById("saveApiKeyButton");
const clearApiKeyButton = document.getElementById("clearApiKeyButton");
const apiKeyStatus = document.getElementById("apiKeyStatus");
const contextSection = document.getElementById("contextSection");
const contextTitle = document.getElementById("contextTitle");
const contextDescription = document.getElementById("contextDescription");
const chartRequirementsText = document.getElementById("chartRequirementsText");
const contextForm = document.getElementById("contextForm");
const positionSectionTitle = document.getElementById("positionSectionTitle");
const positionSectionCopy = document.getElementById("positionSectionCopy");
const symbolOverrideLabel = document.getElementById("symbolOverrideLabel");
const symbolOverrideInput = document.getElementById("symbolOverrideInput");
const entryIntervalLabel = document.getElementById("entryIntervalLabel");
const pendingIntervalLabel = document.getElementById("pendingIntervalLabel");
const positionIntervalLabel = document.getElementById("positionIntervalLabel");
const quickProfitDeltaLabel = document.getElementById("quickProfitDeltaLabel");
const entryIntervalSelect = document.getElementById("entryIntervalSelect");
const pendingIntervalSelect = document.getElementById("pendingIntervalSelect");
const positionIntervalSelect = document.getElementById("positionIntervalSelect");
const quickProfitDeltaInput = document.getElementById("quickProfitDeltaInput");
const formError = document.getElementById("formError");
const confirmButton = document.getElementById("confirmButton");
const runtimeIntervalSection = document.getElementById("runtimeIntervalSection");
const runtimeIntervalTitle = document.getElementById("runtimeIntervalTitle");
const runtimeIntervalCopy = document.getElementById("runtimeIntervalCopy");
const runtimeIntervalStatus = document.getElementById("runtimeIntervalStatus");
const runtimeEntryIntervalLabel = document.getElementById("runtimeEntryIntervalLabel");
const runtimePendingIntervalLabel = document.getElementById("runtimePendingIntervalLabel");
const runtimePositionIntervalLabel = document.getElementById("runtimePositionIntervalLabel");
const runtimeEntryIntervalSelect = document.getElementById("runtimeEntryIntervalSelect");
const runtimePendingIntervalSelect = document.getElementById("runtimePendingIntervalSelect");
const runtimePositionIntervalSelect = document.getElementById("runtimePositionIntervalSelect");
const runtimeIntervalRecommendation = document.getElementById("runtimeIntervalRecommendation");
const runtimeIntervalError = document.getElementById("runtimeIntervalError");
const runtimeSellStrategySection = document.getElementById("runtimeSellStrategySection");
const runtimeSellStrategyTitle = document.getElementById("runtimeSellStrategyTitle");
const runtimeSellStrategyCopy = document.getElementById("runtimeSellStrategyCopy");
const runtimeSellStrategyStatus = document.getElementById("runtimeSellStrategyStatus");
const runtimeQuickProfitDeltaLabel = document.getElementById("runtimeQuickProfitDeltaLabel");
const runtimeQuickProfitDeltaInput = document.getElementById("runtimeQuickProfitDeltaInput");
const runtimeSellStrategyError = document.getElementById("runtimeSellStrategyError");
const marketContextSection = document.getElementById("marketContextSection");
const marketContextTitle = document.getElementById("marketContextTitle");
const marketContextCopy = document.getElementById("marketContextCopy");
const dailyContextStep = document.getElementById("dailyContextStep");
const dailyContextTitle = document.getElementById("dailyContextTitle");
const dailyContextInstructions = document.getElementById("dailyContextInstructions");
const scanDailyContextButton = document.getElementById("scanDailyContextButton");
const hourlyContextStep = document.getElementById("hourlyContextStep");
const hourlyContextTitle = document.getElementById("hourlyContextTitle");
const hourlyContextInstructions = document.getElementById("hourlyContextInstructions");
const scanHourlyContextButton = document.getElementById("scanHourlyContextButton");
const marketContextSummary = document.getElementById("marketContextSummary");
const initialPositionPanel = document.getElementById("initialPositionPanel");
const initialPositionTitle = document.getElementById("initialPositionTitle");
const initialPositionCopy = document.getElementById("initialPositionCopy");
const initialPositionFlatRadio = document.getElementById("initialPositionFlatRadio");
const initialPositionHoldingRadio = document.getElementById("initialPositionHoldingRadio");
const initialPositionFlatLabel = document.getElementById("initialPositionFlatLabel");
const initialPositionHoldingLabel = document.getElementById("initialPositionHoldingLabel");
const initialEntryPriceField = document.getElementById("initialEntryPriceField");
const initialEntryPriceLabel = document.getElementById("initialEntryPriceLabel");
const initialEntryPriceInput = document.getElementById("initialEntryPriceInput");
const initialPositionHint = document.getElementById("initialPositionHint");
const marketContextFiveMinuteReminder = document.getElementById("marketContextFiveMinuteReminder");
const marketContextError = document.getElementById("marketContextError");
const confirmMarketContextButton = document.getElementById("confirmMarketContextButton");
const recommendationTitle = document.getElementById("recommendationTitle");
const analysisCard = document.getElementById("analysisCard");
const recentRoundsTitle = document.getElementById("recentRoundsTitle");
const recentRoundsList = document.getElementById("recentRoundsList");
const statsSection = document.getElementById("statsSection");
const statsTitle = document.getElementById("statsTitle");
const statsCopy = document.getElementById("statsCopy");
const statsContent = document.getElementById("statsContent");
const tradeJournalTitle = document.getElementById("tradeJournalTitle");
const tradeJournalCopy = document.getElementById("tradeJournalCopy");
const tradeJournalList = document.getElementById("tradeJournalList");
const positionSection = document.getElementById("positionSection");
const positionSectionHeaderTitle = document.getElementById("positionSectionHeaderTitle");
const positionSectionHeaderCopy = document.getElementById("positionSectionHeaderCopy");
const positionSummary = document.getElementById("positionSummary");
const positionActions = document.getElementById("positionActions");
const exitPriceLabelSpan = document.getElementById("exitPriceLabel");
const exitPriceInput = document.getElementById("exitPriceInput");
const markSoldButton = document.getElementById("markSoldButton");
const positionError = document.getElementById("positionError");
const markLimitPlacedSection = document.getElementById("markLimitPlacedSection");
const markLimitPlacedTitle = document.getElementById("markLimitPlacedTitle");
const markLimitPlacedCopy = document.getElementById("markLimitPlacedCopy");
const limitPlacedPriceLabel = document.getElementById("limitPlacedPriceLabel");
const limitPlacedPriceInput = document.getElementById("limitPlacedPriceInput");
const markLimitPlacedButton = document.getElementById("markLimitPlacedButton");
const markLimitPlacedError = document.getElementById("markLimitPlacedError");
const pendingLimitSection = document.getElementById("pendingLimitSection");
const pendingLimitTitle = document.getElementById("pendingLimitTitle");
const pendingLimitCopy = document.getElementById("pendingLimitCopy");
const pendingLimitSummary = document.getElementById("pendingLimitSummary");
const pendingLimitStaleWarning = document.getElementById("pendingLimitStaleWarning");
const pendingLimitSignalChanged = document.getElementById("pendingLimitSignalChanged");
const pendingLimitFilledButton = document.getElementById("pendingLimitFilledButton");
const pendingLimitCancelButton = document.getElementById("pendingLimitCancelButton");
const pendingLimitError = document.getElementById("pendingLimitError");

const STALE_LIMIT_THRESHOLD_MINUTES = 10;

let isStartingMonitoring = false;
let scanningMarketContextTimeframe = null;
let isConfirmingMarketContext = false;
let initialPositionMode = "flat";
let isUpdatingRuntimeIntervals = false;
let isUpdatingSellStrategy = false;

// Set an input's value WITHOUT clobbering what the user is currently typing.
// number / text inputs only fire `change` on blur or Enter, so any render() that
// runs while the user is mid-edit will reset their typed value unless we skip
// the focused input. The optional `skip` argument lets callers also bail when
// a save round-trip is in flight (the input visually holds the new value but
// the persisted state hasn't caught up yet — overwriting would flicker).
function safeSetInputValue(input, value, skip = false) {
  if (skip || document.activeElement === input) {
    return;
  }
  input.value = value;
}

function escapeHtml(value) {
  return `${value}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatActionLabel(language, action) {
  return action ? t(language, `action_${action}`) : t(language, "unknown");
}

function getSellLimitIntentFromPrices(action, orderPrice, currentPrice) {
  if (action !== "SELL_LIMIT") {
    return null;
  }

  const order = parsePositivePrice(orderPrice);
  const current = parsePositivePrice(currentPrice);
  if (!order || !current) {
    return null;
  }

  return order <= current ? "defensive" : "profit";
}

function getSellLimitIntent(analysis) {
  return getSellLimitIntentFromPrices(analysis?.action, analysis?.orderPrice, analysis?.currentPrice);
}

function formatAnalysisActionLabel(language, analysis) {
  const sellLimitIntent = getSellLimitIntent(analysis);
  if (sellLimitIntent === "defensive") {
    return t(language, "sellLimitDefensiveAction");
  }
  if (sellLimitIntent === "profit") {
    return t(language, "sellLimitProfitAction");
  }
  return formatActionLabel(language, analysis?.action);
}

function formatAnalysisIntervalLabel(language, value) {
  return t(language, `analysisInterval_${normalizeAnalysisInterval(value)}`);
}

function getActionTone(action) {
  if (action === "BUY_LIMIT") {
    return "buy";
  }

  if (action === "SELL_NOW" || action === "SELL_LIMIT") {
    return "sell";
  }

  if (action === "WAIT") {
    return "wait";
  }

  return "no-trade";
}

function renderMetricCard(language, label, value, { fullSpan = false, tone = null } = {}) {
  const toneAttr = tone ? ` data-tone="${escapeHtml(tone)}"` : "";
  return `
    <article class="metric-card${fullSpan ? " full-span" : ""}"${toneAttr}>
      <p class="metric-label">${escapeHtml(label)}</p>
      <p class="metric-value">${escapeHtml(value || t(language, "nA"))}</p>
    </article>
  `;
}

function renderGuidanceCard(label, value) {
  return `
    <article class="guidance-card">
      <p class="metric-label">${escapeHtml(label)}</p>
      <p class="guidance-value">${escapeHtml(value)}</p>
    </article>
  `;
}

function getOrderGuidanceValue(language, analysis) {
  if (analysis.action === "WAIT") {
    return t(language, "noOrderNow");
  }

  if (analysis.action === "HOLD") {
    return t(language, "holdNoOrderNow");
  }

  if (analysis.action === "SELL_NOW") {
    return analysis.currentPrice || t(language, "nA");
  }

  return analysis.orderPrice || t(language, "nA");
}

function getOrderGuidanceLabel(language, analysis) {
  const sellLimitIntent = getSellLimitIntent(analysis);
  if (sellLimitIntent === "defensive") {
    return t(language, "sellLimitFloorPriceLabel");
  }
  if (sellLimitIntent === "profit") {
    return t(language, "sellLimitTakeProfitPriceLabel");
  }
  return analysis.action === "SELL_NOW" ? t(language, "currentPrice") : t(language, "orderPriceLabel");
}

function getDisplayAnalysis(state) {
  return { analysis: state.lastResult?.analysis || null };
}

function parsePositivePrice(value) {
  const price = Number(`${value ?? ""}`.trim());
  return Number.isFinite(price) && price > 0 ? price : null;
}

function formatDollar(value) {
  const price = Number(`${value ?? ""}`.trim());
  return Number.isFinite(price) ? price.toFixed(2) : "";
}

function formatDollarSigned(value) {
  const price = Number(`${value ?? ""}`.trim());
  if (!Number.isFinite(price)) return "";
  const sign = price >= 0 ? "+" : "";
  return `${sign}${price.toFixed(2)}`;
}

function getNearbyMarketLevels(summary, currentPrice) {
  const levels = Array.isArray(summary?.keyLevels) ? summary.keyLevels : [];
  const price = parsePositivePrice(currentPrice);
  if (!price || levels.length === 0) {
    return { support: null, resistance: null };
  }

  const supportTypes = new Set(["support", "pivot", "gap", "prior_low"]);
  const resistanceTypes = new Set(["resistance", "pivot", "gap", "prior_high"]);
  const parsed = levels
    .map((level) => ({ ...level, numericPrice: parsePositivePrice(level.price) }))
    .filter((level) => level.numericPrice);

  const support = parsed
    .filter((level) => level.numericPrice <= price && supportTypes.has(level.type))
    .sort((a, b) => b.numericPrice - a.numericPrice)[0] || null;
  const resistance = parsed
    .filter((level) => level.numericPrice >= price && resistanceTypes.has(level.type))
    .sort((a, b) => a.numericPrice - b.numericPrice)[0] || null;

  return { support, resistance };
}

function formatDistanceFromCurrent(level, currentPrice) {
  const price = parsePositivePrice(currentPrice);
  const levelPrice = parsePositivePrice(level?.price);
  if (!price || !levelPrice) {
    return "";
  }

  const pct = ((levelPrice - price) / price) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function renderNearbyLevel(language, titleKey, level, currentPrice, tone) {
  if (!level) {
    return `
      <article class="nearby-level" data-tone="empty">
        <p class="nearby-level-label">${escapeHtml(t(language, titleKey))}</p>
        <p class="nearby-level-price">${escapeHtml(t(language, "nA"))}</p>
      </article>
    `;
  }

  const type = formatMarketContextValue(language, level.type, "levelType");
  const strength = formatMarketContextValue(language, level.strength, "levelStrength");
  const distance = formatDistanceFromCurrent(level, currentPrice);
  const meta = [distance, strength, type, level.timeframe].filter(Boolean).join(" · ");

  return `
    <article class="nearby-level" data-tone="${escapeHtml(tone)}">
      <p class="nearby-level-label">${escapeHtml(t(language, titleKey))}</p>
      <p class="nearby-level-price">${escapeHtml(level.price || t(language, "nA"))}</p>
      <p class="nearby-level-meta">${escapeHtml(meta)}</p>
      <p class="nearby-level-reason">${escapeHtml(level.reason || level.label || "")}</p>
    </article>
  `;
}

function renderNearbyMarketLevels(state, analysis, language) {
  const summary = state.marketContext?.summary;
  const levels = getNearbyMarketLevels(summary, analysis.currentPrice);
  if (!levels.support && !levels.resistance) {
    return "";
  }

  return `
    <section class="nearby-levels-panel">
      <div class="nearby-levels-header">
        <h3>${escapeHtml(t(language, "nearbyLevelsTitle"))}</h3>
        <p>${escapeHtml(t(language, "nearbyLevelsCopy"))}</p>
      </div>
      <div class="nearby-levels-grid">
        ${renderNearbyLevel(language, "nearestSupport", levels.support, analysis.currentPrice, "support")}
        ${renderNearbyLevel(language, "nearestResistance", levels.resistance, analysis.currentPrice, "resistance")}
      </div>
    </section>
  `;
}

function renderSellLimitIntentNotice(language, analysis) {
  const intent = getSellLimitIntent(analysis);
  if (!intent) {
    return "";
  }

  const textKey = intent === "defensive"
    ? "sellLimitDefensiveNotice"
    : "sellLimitProfitNotice";
  return `
    <section class="sell-limit-intent-note" data-tone="${escapeHtml(intent)}">
      ${escapeHtml(t(language, textKey))}
    </section>
  `;
}

function formatRoundTime(iso, language) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  } catch {
    return "";
  }
}

function renderRecentRounds(state, language) {
  recentRoundsTitle.textContent = t(language, "recentRoundsTitle");

  const results = Array.isArray(state.results) ? state.results : [];
  if (results.length === 0) {
    recentRoundsList.innerHTML = `<li class="empty-state">${escapeHtml(t(language, "noRoundsYet"))}</li>`;
    return;
  }

  const items = results.slice(0, 10).map((r) => {
    const round = r.round ?? "?";
    const rawAction = r.analysis?.action || "UNKNOWN";
    const action = formatActionLabel(language, r.analysis?.action);
    const time = formatRoundTime(r.capturedAt, language);
    return `<li class="round-item" data-action="${escapeHtml(rawAction)}">
      <span class="round-round">#${escapeHtml(round)}</span>
      <span class="round-action">${escapeHtml(action)}</span>
      <span class="round-time">${escapeHtml(time)}</span>
    </li>`;
  }).join("");

  recentRoundsList.innerHTML = items;
}

function renderAnalysisCard(state, language) {
  const { analysis } = getDisplayAnalysis(state);

  if (isStartingMonitoring || state.isRoundInFlight || (state.status === STATUS.RUNNING && state.roundCount === 0 && !analysis)) {
    analysisCard.className = "analysis-card";
    analysisCard.innerHTML = `
      <section class="loading-card">
        <div class="loading-spinner" aria-hidden="true"></div>
        <p class="loading-title">${escapeHtml(t(language, "analyzingTitle"))}</p>
        <p class="loading-copy">${escapeHtml(t(language, "analyzingCopy"))}</p>
      </section>
    `;
    return;
  }

  if (!analysis) {
    analysisCard.className = "analysis-card empty-analysis";
    analysisCard.innerHTML = `<p class="empty-state">${escapeHtml(t(language, "emptyRecommendation"))}</p>`;
    return;
  }

  const tone = getActionTone(analysis.action);
  const action = formatAnalysisActionLabel(language, analysis);
  const nA = t(language, "nA");

  analysisCard.className = "analysis-card";
  analysisCard.innerHTML = `
    <section class="signal-banner ${tone}">
      <div class="signal-topline">
        <div>
          <p class="signal-label">${escapeHtml(t(language, "actionNow"))}</p>
          <h3 class="signal-value">${escapeHtml(action)}</h3>
        </div>
      </div>
      <div class="guidance-grid">
        ${renderGuidanceCard(getOrderGuidanceLabel(language, analysis), getOrderGuidanceValue(language, analysis))}
      </div>
    </section>
    ${renderSellLimitIntentNotice(language, analysis)}
    <div class="analysis-grid">
      ${renderMetricCard(language, t(language, "currentPrice"), analysis.currentPrice || nA)}
      ${renderMetricCard(language, t(language, "stopLossPriceLabel"), analysis.stopLossPrice || nA)}
      ${renderMetricCard(language, t(language, "targetPriceLabel"), analysis.targetPrice || nA)}
      ${renderMetricCard(language, t(language, "reasoningLabel"), analysis.reasoning || nA, { fullSpan: true })}
    </div>
    ${renderNearbyMarketLevels(state, analysis, language)}
  `;
}

function getMonitoringDetailCopy(language, round, interval) {
  return t(language, "monitoringDetail", { round, interval });
}

function getPanelSectionTitle(language, section) {
  const labels = {
    position: t(language, "sessionSetup"),
    rules: t(language, "executionRules")
  };
  return labels[section] || section;
}

function getPanelSectionCopy(language, section) {
  const labels = {
    position: t(language, "sessionSetupCopy"),
    rules: t(language, "executionRulesCopy")
  };
  return labels[section] || "";
}

function formatPnlLabel(pct) {
  if (!Number.isFinite(pct)) return "—";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function formatPctSigned(value) {
  if (!Number.isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatWinRate(value) {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(0)}%`;
}

function formatHeldMinutes(value) {
  if (!Number.isFinite(value)) return "—";
  return `${Math.round(value)}m`;
}

function getPnlTone(value) {
  if (!Number.isFinite(value)) return "neutral";
  if (value > 0) return "win";
  if (value < 0) return "loss";
  return "neutral";
}

function renderStatsOverall(language, overall) {
  const pnlTone = getPnlTone(overall.avgPnlPercent);
  const totalTone = getPnlTone(overall.totalPnlPercent);
  return `
    <div class="stats-overall">
      <div class="stats-overall-grid">
        <div class="stats-metric-block"><span class="stats-metric-k">${escapeHtml(t(language, "statsSampleSize"))}</span><span class="stats-metric-v-big">${overall.n}</span></div>
        <div class="stats-metric-block"><span class="stats-metric-k">${escapeHtml(t(language, "statsWinRate"))}</span><span class="stats-metric-v-big">${escapeHtml(formatWinRate(overall.winRate))} <small>(${overall.wins}/${overall.n})</small></span></div>
        <div class="stats-metric-block" data-tone="${pnlTone}"><span class="stats-metric-k">${escapeHtml(t(language, "statsAvgPnl"))}</span><span class="stats-metric-v-big">${escapeHtml(formatPctSigned(overall.avgPnlPercent))}</span></div>
        <div class="stats-metric-block" data-tone="${totalTone}"><span class="stats-metric-k">${escapeHtml(t(language, "statsTotalPnl"))}</span><span class="stats-metric-v-big">${escapeHtml(formatPctSigned(overall.totalPnlPercent))}</span></div>
        <div class="stats-metric-block"><span class="stats-metric-k">${escapeHtml(t(language, "statsAvgHeld"))}</span><span class="stats-metric-v-big">${escapeHtml(formatHeldMinutes(overall.avgHeldMinutes))}</span></div>
        <div class="stats-metric-block"><span class="stats-metric-k">${escapeHtml(t(language, "statsBestTrade"))} / ${escapeHtml(t(language, "statsWorstTrade"))}</span><span class="stats-metric-v-big">${escapeHtml(formatPctSigned(overall.bestPnlPercent))} / ${escapeHtml(formatPctSigned(overall.worstPnlPercent))}</span></div>
      </div>
    </div>
  `;
}

function renderStatsCard(state, language) {
  statsTitle.textContent = t(language, "statsTitle");
  statsCopy.textContent = t(language, "statsCopy");

  const stats = computeTradeStats(state.tradeHistory);
  if (stats.overall.n === 0) {
    statsSection.classList.add("hidden");
    return;
  }
  statsSection.classList.remove("hidden");

  statsContent.innerHTML = `
    <h3 class="stats-heading">${escapeHtml(t(language, "statsOverallHeading"))}</h3>
    ${renderStatsOverall(language, stats.overall)}
  `;
}

function renderTradeJournal(state, language) {
  tradeJournalTitle.textContent = t(language, "tradeJournalTitle");
  tradeJournalCopy.textContent = t(language, "tradeJournalCopy");

  const history = Array.isArray(state.tradeHistory) ? state.tradeHistory : [];
  if (history.length === 0) {
    tradeJournalList.innerHTML = `<li class="empty-state">${escapeHtml(t(language, "noClosedTrades"))}</li>`;
    return;
  }

  const items = history.slice(0, 10).map((trade) => {
    const isAbandoned = trade.status === "abandoned";
    const tone = isAbandoned
      ? "abandoned"
      : (Number.isFinite(trade.pnlPercent) && trade.pnlPercent >= 0 ? "win" : "loss");
    const pnl = isAbandoned
      ? t(language, "tradeAbandonedBadge")
      : formatPnlLabel(trade.pnlPercent);
    const symbol = trade.symbol || "?";
    const entry = trade.entryPrice || "?";
    const exit = trade.exitPrice || "?";
    const lesson = isAbandoned
      ? `<em>${escapeHtml(t(language, "tradeAbandonedLesson"))}</em>`
      : (trade.lesson && trade.lesson.trim()
          ? escapeHtml(trade.lesson)
          : `<em>${escapeHtml(t(language, "lessonPending"))}</em>`);
    const held = Number.isFinite(trade.heldMinutes) ? `${trade.heldMinutes}m` : "—";
    return `<li class="journal-item" data-tone="${tone}">
      <div class="journal-headline">
        <span class="journal-symbol">${escapeHtml(symbol)}</span>
        <span class="journal-pnl ${tone}">${escapeHtml(pnl)}</span>
        <span class="journal-held">${escapeHtml(held)}</span>
      </div>
      <div class="journal-prices">${escapeHtml(entry)} → ${escapeHtml(exit)}</div>
      <p class="journal-lesson">${lesson}</p>
    </li>`;
  }).join("");

  tradeJournalList.innerHTML = items;
}

function minutesSinceIso(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

function renderPendingLimitCard(state, language, pending) {
  pendingLimitSection.classList.remove("hidden");
  pendingLimitTitle.textContent = t(language, "limitOrderTitle");
  pendingLimitCopy.textContent = t(language, "limitOrderCopy");

  const isBuy = pending.action === "BUY_LIMIT";
  pendingLimitFilledButton.textContent = t(language, isBuy ? "limitFilledButton_buy" : "limitFilledButton_sell");
  pendingLimitFilledButton.className = `mode-button ${isBuy ? "buy-button" : "sell-button"}`;
  pendingLimitCancelButton.textContent = t(language, "limitCancelButton");

  const nA = t(language, "nA");
  const pendingAnalysisView = {
    action: pending.action,
    orderPrice: pending.limitPrice,
    currentPrice: state.lastResult?.analysis?.currentPrice || null
  };
  const actionLabel = formatAnalysisActionLabel(language, pendingAnalysisView);
  const sellLimitIntent = getSellLimitIntent(pendingAnalysisView);
  const limitPriceLabel = sellLimitIntent === "defensive"
    ? t(language, "sellLimitFloorPriceLabel")
    : sellLimitIntent === "profit"
      ? t(language, "sellLimitTakeProfitPriceLabel")
      : t(language, "limitPriceLabel");
  const intentNote = sellLimitIntent === "defensive"
    ? `<p class="position-line limit-intent-inline">${escapeHtml(t(language, "sellLimitDefensiveNotice"))}</p>`
    : "";
  const held = minutesSinceIso(pending.placedAt);
  const heldText = Number.isFinite(held) ? `${held}m` : nA;
  pendingLimitSummary.innerHTML = `
    <p class="position-line"><strong>${escapeHtml(t(language, "actionNow"))}:</strong> ${escapeHtml(actionLabel)}</p>
    <p class="position-line"><strong>${escapeHtml(t(language, "symbolOverride"))}:</strong> ${escapeHtml(pending.symbol || nA)}</p>
    <p class="position-line"><strong>${escapeHtml(limitPriceLabel)}:</strong> ${escapeHtml(pending.limitPrice || nA)}</p>
    <p class="position-line"><strong>${escapeHtml(t(language, "stopLossPriceLabel"))}:</strong> ${escapeHtml(pending.stopLossPrice || nA)}</p>
    <p class="position-line"><strong>${escapeHtml(t(language, "targetPriceLabel"))}:</strong> ${escapeHtml(pending.targetPrice || nA)}</p>
    <p class="position-line"><strong>${escapeHtml(t(language, "statsAvgHeld"))}:</strong> ${escapeHtml(heldText)}</p>
    ${intentNote}
  `;

  if (Number.isFinite(held) && held >= STALE_LIMIT_THRESHOLD_MINUTES) {
    pendingLimitStaleWarning.textContent = t(language, "limitStaleWarning", { minutes: held });
    pendingLimitStaleWarning.classList.remove("hidden");
  } else {
    pendingLimitStaleWarning.textContent = "";
    pendingLimitStaleWarning.classList.add("hidden");
  }

  // Three distinct warning flavors for a resting limit whose context has shifted:
  //   - action reversed  (BUY_LIMIT → SELL_* / HOLD, etc.): strongest signal, definitely cancel
  //   - action stepped down (BUY_LIMIT → WAIT, SELL_LIMIT → HOLD): AI retreated, likely invalidated
  //   - same action, price drifted > PRICE_DRIFT_THRESHOLD: order parked at now-wrong level
  // Banner is suppressed only when action matches AND price is still close.
  const PRICE_DRIFT_THRESHOLD = 0.003; // 0.3% — ignores sub-tick noise, catches real re-leveling
  const currentAction = state.lastResult?.analysis?.action;
  const currentOrderPrice = Number(state.lastResult?.analysis?.orderPrice);
  const pendingPriceNum = Number(pending.limitPrice);
  const priceDrift =
    Number.isFinite(pendingPriceNum) && pendingPriceNum > 0 && Number.isFinite(currentOrderPrice)
      ? Math.abs(currentOrderPrice - pendingPriceNum) / pendingPriceNum
      : 0;

  let warningKey = null;
  if (currentAction && currentAction !== pending.action) {
    // Action changed. WAIT/HOLD = AI retreated; other direction = reversal.
    warningKey = currentAction === "WAIT" || currentAction === "HOLD"
      ? "limitSignalRetreatedWarning"
      : "limitSignalChangedWarning";
  } else if (currentAction === pending.action && priceDrift > PRICE_DRIFT_THRESHOLD) {
    warningKey = "limitPriceDriftedWarning";
  }

  if (warningKey) {
    pendingLimitSignalChanged.textContent = t(language, warningKey, {
      prevAction: pending.action,
      prevPrice: pending.limitPrice || nA,
      currAction: currentAction || nA,
      currPrice: Number.isFinite(currentOrderPrice) ? currentOrderPrice.toFixed(2) : nA,
      driftPct: (priceDrift * 100).toFixed(2)
    });
    pendingLimitSignalChanged.classList.remove("hidden");
  } else {
    pendingLimitSignalChanged.textContent = "";
    pendingLimitSignalChanged.classList.add("hidden");
  }

  pendingLimitError.textContent = "";
  pendingLimitError.classList.add("hidden");
}

function renderMarkLimitPlacedCard(state, language, action) {
  markLimitPlacedSection.classList.remove("hidden");
  const isBuy = action === "BUY_LIMIT";
  const analysis = state.lastResult?.analysis;
  const sellLimitIntent = getSellLimitIntent(analysis);
  const sellTitleKey = sellLimitIntent === "defensive"
    ? "markLimitPlacedTitle_sellDefensive"
    : sellLimitIntent === "profit"
      ? "markLimitPlacedTitle_sellProfit"
      : "markLimitPlacedTitle_sell";
  const sellButtonKey = sellLimitIntent === "defensive"
    ? "markLimitPlacedButton_sellDefensive"
    : "markLimitPlacedButton_sell";
  markLimitPlacedTitle.textContent = t(language, isBuy ? "markLimitPlacedTitle_buy" : sellTitleKey);
  markLimitPlacedCopy.textContent = sellLimitIntent === "defensive"
    ? t(language, "markLimitPlacedCopy_sellDefensive")
    : t(language, "markLimitPlacedCopy");
  limitPlacedPriceLabel.textContent = sellLimitIntent === "defensive"
    ? t(language, "sellLimitFloorPriceLabel")
    : t(language, "limitPriceLabel");
  markLimitPlacedButton.textContent = t(language, isBuy ? "markLimitPlacedButton_buy" : sellButtonKey);
  markLimitPlacedButton.className = `mode-button ${isBuy ? "buy-button" : "sell-button"}`;

  const suggested = analysis?.orderPrice || "";
  if (suggested && !limitPlacedPriceInput.value) {
    limitPlacedPriceInput.value = suggested;
  }

  markLimitPlacedError.textContent = "";
  markLimitPlacedError.classList.add("hidden");
}

function renderPositionPanels(state, language) {
  const position = state.virtualPosition;
  const pending = state.pendingLimitOrder;
  const lastAction = state.lastResult?.analysis?.action;
  const isRunning = state.status === STATUS.RUNNING;

  positionSectionHeaderTitle.textContent = t(language, "virtualPositionTitle");
  positionSectionHeaderCopy.textContent = t(language, "virtualPositionCopy");
  exitPriceLabelSpan.textContent = t(language, "exitPriceLabel");
  markSoldButton.textContent = t(language, "markSoldButton");

  // Hide all optional cards by default; each branch below re-enables what applies.
  markLimitPlacedSection.classList.add("hidden");
  pendingLimitSection.classList.add("hidden");

  if (position) {
    positionSection.classList.remove("hidden");
    positionActions.classList.remove("hidden");
    const nA = t(language, "nA");
    const profile = state.monitoringProfile || state.lastMonitoringProfile || {};
    const sellLevels = buildSellStrategyContext(position, profile.rules || {});
    const currentPrice = parsePositivePrice(state.lastResult?.analysis?.currentPrice);
    const entryPrice = parsePositivePrice(position.entryPrice);
    const floatingDelta = currentPrice && entryPrice ? formatDollarSigned(currentPrice - entryPrice) : nA;
    positionSummary.innerHTML = `
      <p class="position-line"><strong>${escapeHtml(t(language, "symbolOverride"))}:</strong> ${escapeHtml(position.symbol || nA)}</p>
      <p class="position-line"><strong>${escapeHtml(t(language, "entryPriceLabel"))}:</strong> ${escapeHtml(position.entryPrice || nA)}</p>
      <p class="position-line"><strong>${escapeHtml(t(language, "currentPrice"))}:</strong> ${escapeHtml(state.lastResult?.analysis?.currentPrice || nA)}</p>
      <p class="position-line"><strong>${escapeHtml(t(language, "floatingDelta"))}:</strong> ${escapeHtml(floatingDelta)}</p>
      <p class="position-line"><strong>${escapeHtml(t(language, "quickProfitTrigger"))}:</strong> ${escapeHtml(sellLevels?.quickProfitPrice || nA)}</p>
      <p class="position-line"><strong>${escapeHtml(t(language, "stopLossPriceLabel"))}:</strong> ${escapeHtml(position.stopLossPrice || nA)}</p>
      <p class="position-line"><strong>${escapeHtml(t(language, "targetPriceLabel"))}:</strong> ${escapeHtml(position.targetPrice || nA)}</p>
    `;

    // Prefill exitPriceInput with the AI's currentPrice — user marking a manual
    // sell is essentially a market exit, so currentPrice (≈ live market price
    // from this round) is a better starting point than blank. They can still
    // edit before submitting. Skip if user has already typed something.
    const suggestedExit = state.lastResult?.analysis?.currentPrice || "";
    if (suggestedExit && !exitPriceInput.value) {
      exitPriceInput.value = suggestedExit;
    }

    // Holding → pending SELL_LIMIT (exit-mode limit order); or show markLimitPlaced when AI says SELL_LIMIT.
    if (pending && pending.action === "SELL_LIMIT") {
      renderPendingLimitCard(state, language, pending);
    } else if (isRunning && lastAction === "SELL_LIMIT") {
      renderMarkLimitPlacedCard(state, language, "SELL_LIMIT");
    }
    return;
  }

  positionSection.classList.add("hidden");

  // Flat → pending BUY_LIMIT (entry-mode limit order); or show markLimitPlaced
  // when AI says BUY_LIMIT. BUY_NOW is no longer in the action vocabulary
  // (the user's "all entries via limit" principle), so there is no
  // "manual mark bought" path here — entries always flow through:
  //   AI BUY_LIMIT → user places at broker → "Mark limit placed" → wait → "Limit filled"
  // The "Limit filled" button calls markBought internally with pending.limitPrice.
  if (pending && pending.action === "BUY_LIMIT") {
    renderPendingLimitCard(state, language, pending);
    return;
  }

  if (isRunning && lastAction === "BUY_LIMIT") {
    renderMarkLimitPlacedCard(state, language, "BUY_LIMIT");
  }
}

function updateStaticText(language, settings) {
  heroEyebrow.textContent = t(language, "liveAnalysis");
  heroTitle.textContent = t(language, "appTitle");
  saveApiKeyButton.textContent = t(language, "saveKey");
  clearApiKeyButton.textContent = t(language, "clearKey");
  stopMonitorButton.textContent = t(language, "stop");
  continueMonitorButton.textContent = t(language, "continue");
  exitMonitorButton.textContent = t(language, "exit");
  apiSetupTitle.textContent = t(language, "openAiSetup");
  apiSetupCopy.innerHTML = `${escapeHtml(t(language, "setupCopy"))}`;
  apiKeyLabel.textContent = t(language, "openAiApiKey");
  contextTitle.textContent = t(language, "tradingSetup");
  contextDescription.textContent = t(language, "tradingSetupCopy");
  chartRequirementsText.textContent = t(language, "chartSetupCopy");
  positionSectionTitle.textContent = getPanelSectionTitle(language, "position");
  positionSectionCopy.textContent = getPanelSectionCopy(language, "position");
  symbolOverrideLabel.textContent = t(language, "symbolOverride");
  symbolOverrideInput.placeholder = t(language, "symbolOverridePlaceholder");
  entryIntervalLabel.textContent = t(language, "entryInterval");
  pendingIntervalLabel.textContent = t(language, "pendingInterval");
  positionIntervalLabel.textContent = t(language, "positionInterval");
  quickProfitDeltaLabel.textContent = t(language, "quickProfitDelta");
  runtimeIntervalTitle.textContent = t(language, "runtimeIntervalTitle");
  runtimeIntervalCopy.textContent = t(language, "runtimeIntervalCopy");
  runtimeEntryIntervalLabel.textContent = t(language, "entryInterval");
  runtimePendingIntervalLabel.textContent = t(language, "pendingInterval");
  runtimePositionIntervalLabel.textContent = t(language, "positionInterval");
  runtimeSellStrategyTitle.textContent = t(language, "runtimeSellStrategyTitle");
  runtimeSellStrategyCopy.textContent = t(language, "runtimeSellStrategyCopy");
  runtimeQuickProfitDeltaLabel.textContent = t(language, "quickProfitDelta");
  confirmButton.textContent = t(language, "start");
  recommendationTitle.textContent = t(language, "latestRecommendation");
  apiKeyStatus.textContent = settings.openaiApiKey
    ? t(language, "apiKeySaved", { model: settings.model })
    : t(language, "noApiKeySaved");
}

function getSummary(state, language) {
  if (state.status === STATUS.VALIDATING) {
    return t(language, "validatingDetail");
  }

  if (state.status === STATUS.AWAITING_CONTEXT) {
    if ((state.monitoringProfile || state.lastMonitoringProfile) && state.marketContext?.symbol) {
      return t(language, "marketContextRequiredDetail");
    }
    return t(language, "fillSetupDetail");
  }

  if (state.status === STATUS.RUNNING && state.isRoundInFlight) {
    return t(language, "analyzingCopy");
  }

  if (state.status === STATUS.RUNNING && state.stopReason) {
    return state.stopReason;
  }

  if (state.status === STATUS.RUNNING) {
    const profile = state.monitoringProfile || state.lastMonitoringProfile || {};
    const intervalRule = getActiveAnalysisIntervalRule(state, profile.rules || {});

    return getMonitoringDetailCopy(
      language,
      state.roundCount,
      formatAnalysisIntervalLabel(language, intervalRule)
    );
  }

  return state.lastError || state.stopReason || t(language, "clickStart");
}

function hasApiKey(settings) {
  return Boolean(settings.openaiApiKey);
}

function hasSavedMonitoringSession(state) {
  return Boolean(state.monitoringProfile || state.lastMonitoringProfile);
}

function getStatusBadgeLabel(language, status) {
  if (!status || status === STATUS.IDLE) {
    return t(language, "idle");
  }
  return t(language, `status_${status}`);
}

function buildAnalysisIntervalOptions(language) {
  return ANALYSIS_INTERVAL_OPTIONS
    .map((option) => `<option value="${option.value}">${escapeHtml(t(language, `analysisInterval_${option.value}`))}</option>`)
    .join("");
}

function populateAnalysisIntervalSelect(select, language, selectedValue = "5m") {
  select.innerHTML = buildAnalysisIntervalOptions(language);
  select.value = normalizeAnalysisInterval(selectedValue);
}

function populateIntervalSelects({ entrySelect, pendingSelect, positionSelect }, language, rules = {}) {
  const intervals = normalizeAnalysisIntervalRules(rules);
  populateAnalysisIntervalSelect(entrySelect, language, intervals.entryInterval);
  populateAnalysisIntervalSelect(pendingSelect, language, intervals.pendingInterval);
  populateAnalysisIntervalSelect(positionSelect, language, intervals.positionInterval);
}

function populateSellStrategyInputs({ quickProfitInput }, rules = {}) {
  const sellRules = normalizeSellStrategyRules(rules);
  safeSetInputValue(quickProfitInput, sellRules.quickProfitDelta);
}

function populateContextForm(state, language) {
  const profile = state.monitoringProfile || state.lastMonitoringProfile;
  safeSetInputValue(symbolOverrideInput, profile?.symbolOverride ?? "");
  populateIntervalSelects({
    entrySelect: entryIntervalSelect,
    pendingSelect: pendingIntervalSelect,
    positionSelect: positionIntervalSelect
  }, language, profile?.rules);
  populateSellStrategyInputs({
    quickProfitInput: quickProfitDeltaInput
  }, profile?.rules);
}

function isMarketContextSetupActive(state) {
  return state.status === STATUS.AWAITING_CONTEXT
    && Boolean(state.monitoringProfile || state.lastMonitoringProfile)
    && Boolean(state.marketContext?.symbol);
}

function formatMarketContextValue(language, value, prefix) {
  const key = `${prefix}_${value}`;
  const label = t(language, key);
  return label === key ? (value || t(language, "unknown")) : label;
}

function renderKeyLevelList(language, keyLevels) {
  if (!Array.isArray(keyLevels) || keyLevels.length === 0) {
    return `<p class="form-hint">${escapeHtml(t(language, "marketContextNoKeyLevels"))}</p>`;
  }

  return `<ol class="market-context-levels">
    ${keyLevels.map((level) => {
      const zone = level.zoneLow && level.zoneHigh
        ? ` (${level.zoneLow}-${level.zoneHigh})`
        : "";
      return `<li>
        <span class="level-price">${escapeHtml(level.price || t(language, "nA"))}${escapeHtml(zone)}</span>
        <span class="level-meta">${escapeHtml(formatMarketContextValue(language, level.strength, "levelStrength"))} · ${escapeHtml(formatMarketContextValue(language, level.type, "levelType"))} · ${escapeHtml(level.timeframe || "")}</span>
        <span class="level-reason">${escapeHtml(level.reason || "")}</span>
      </li>`;
    }).join("")}
  </ol>`;
}

function renderMarketContextSummary(state, language) {
  const summary = state.marketContext?.summary;
  if (!summary) {
    marketContextSummary.innerHTML = "";
    marketContextSummary.classList.add("hidden");
    return;
  }

  marketContextSummary.innerHTML = `
    <h3>${escapeHtml(t(language, "marketContextSummaryTitle"))}</h3>
    <div class="analysis-grid">
      ${renderMetricCard(language, t(language, "marketContextRegime"), formatMarketContextValue(language, summary.regime, "marketRegime"))}
      ${renderMetricCard(language, t(language, "marketContextAggression"), formatMarketContextValue(language, summary.aggression, "marketAggression"))}
      ${renderMetricCard(language, t(language, "marketContextDipBuyPolicy"), formatMarketContextValue(language, summary.dipBuyPolicy, "marketDipBuyPolicy"))}
      ${renderMetricCard(language, t(language, "marketContextProfitTakingStyle"), formatMarketContextValue(language, summary.profitTakingStyle, "marketProfitTakingStyle"))}
      ${renderMetricCard(language, t(language, "marketContextRiskNotes"), summary.riskNotes || t(language, "nA"), { fullSpan: true })}
    </div>
    <h3>${escapeHtml(t(language, "marketContextKeyLevels"))}</h3>
    ${renderKeyLevelList(language, summary.keyLevels)}
  `;
  marketContextSummary.classList.remove("hidden");
}

function getInitialPositionSelection() {
  const mode = initialPositionMode === "holding" ? "holding" : "flat";
  return {
    mode,
    entryPrice: initialEntryPriceInput.value.trim(),
    entryPriceValid: mode !== "holding" || parsePositivePrice(initialEntryPriceInput.value) !== null
  };
}

function renderInitialPositionPanel(language, complete) {
  initialPositionPanel.classList.toggle("hidden", !complete);
  if (!complete) {
    initialPositionMode = "flat";
    initialEntryPriceInput.value = "";
    return { mode: "flat", entryPrice: "", entryPriceValid: true };
  }

  const selected = getInitialPositionSelection();
  initialPositionTitle.textContent = t(language, "initialPositionTitle");
  initialPositionCopy.textContent = t(language, "initialPositionCopy");
  initialPositionFlatLabel.textContent = t(language, "initialPositionFlat");
  initialPositionHoldingLabel.textContent = t(language, "initialPositionHolding");
  initialEntryPriceLabel.textContent = t(language, "initialEntryPriceLabel");
  initialPositionFlatRadio.checked = selected.mode === "flat";
  initialPositionHoldingRadio.checked = selected.mode === "holding";
  initialEntryPriceField.classList.toggle("hidden", selected.mode !== "holding");
  initialPositionHint.textContent = selected.mode === "holding"
    ? t(language, "initialPositionHoldingHint")
    : t(language, "initialPositionFlatHint");

  return selected;
}

function renderMarketContextSection(state, language, apiReady) {
  const shouldShow = isMarketContextSetupActive(state);
  marketContextSection.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) {
    initialPositionMode = "flat";
    initialEntryPriceInput.value = "";
    initialPositionPanel.classList.add("hidden");
    marketContextFiveMinuteReminder.textContent = "";
    marketContextFiveMinuteReminder.classList.add("hidden");
    marketContextError.textContent = "";
    marketContextError.classList.add("hidden");
    return;
  }

  const marketContext = state.marketContext || {};
  const dailyDone = Boolean(marketContext.dailyScan);
  const hourlyDone = Boolean(marketContext.hourlyScan);
  const complete = marketContext.status === MARKET_CONTEXT_STATUS.COMPLETE && Boolean(marketContext.summary);

  marketContextTitle.textContent = t(language, "marketContextTitle");
  marketContextCopy.textContent = t(language, "marketContextCopy", {
    symbol: marketContext.symbol || state.monitoringProfile?.symbolOverride || t(language, "unknown")
  });
  dailyContextTitle.textContent = t(language, "marketContextDailyTitle");
  dailyContextInstructions.textContent = t(language, "marketContextDailyInstructions");
  hourlyContextTitle.textContent = t(language, "marketContextHourlyTitle");
  hourlyContextInstructions.textContent = t(language, "marketContextHourlyInstructions");
  scanDailyContextButton.textContent = scanningMarketContextTimeframe === "daily"
    ? t(language, "marketContextScanning")
    : (dailyDone ? t(language, "rescanDailyContext") : t(language, "scanDailyContext"));
  scanHourlyContextButton.textContent = scanningMarketContextTimeframe === "1h"
    ? t(language, "marketContextScanning")
    : (hourlyDone ? t(language, "rescanHourlyContext") : t(language, "scanHourlyContext"));
  confirmMarketContextButton.textContent = isConfirmingMarketContext
    ? t(language, "startMonitoringProgress")
    : t(language, "confirmMarketContext");

  dailyContextStep.dataset.status = dailyDone ? "done" : "pending";
  hourlyContextStep.dataset.status = hourlyDone ? "done" : "pending";
  scanDailyContextButton.disabled = !apiReady || scanningMarketContextTimeframe !== null || isConfirmingMarketContext;
  scanHourlyContextButton.disabled = !apiReady || !dailyDone || scanningMarketContextTimeframe !== null || isConfirmingMarketContext;
  const initialPosition = renderInitialPositionPanel(language, complete);
  const initialPositionInvalid = complete && !initialPosition.entryPriceValid;
  confirmMarketContextButton.disabled = !apiReady
    || !complete
    || initialPositionInvalid
    || scanningMarketContextTimeframe !== null
    || isConfirmingMarketContext;
  scanHourlyContextButton.title = dailyDone ? "" : t(language, "marketContextDailyRequired");
  confirmMarketContextButton.title = initialPositionInvalid
    ? t(language, "initialEntryPriceInvalid")
    : (complete ? "" : t(language, "marketContextNotComplete"));
  marketContextFiveMinuteReminder.textContent = t(language, "marketContextFiveMinuteReminder");
  marketContextFiveMinuteReminder.classList.toggle("hidden", !complete);

  renderMarketContextSummary(state, language);

  const error = marketContext.lastError || "";
  if (error) {
    marketContextError.textContent = error;
    marketContextError.classList.remove("hidden");
  } else {
    marketContextError.textContent = "";
    marketContextError.classList.add("hidden");
  }
}

function formatAnalysisPhaseLabel(language, phase) {
  return t(language, `analysisPhase_${phase}`);
}

function renderRuntimeIntervalSection(state, language, apiReady) {
  const profile = state.monitoringProfile || state.lastMonitoringProfile;
  const shouldShow = Boolean(profile) && (state.status === STATUS.RUNNING || state.status === STATUS.PAUSED);
  runtimeIntervalSection.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) {
    runtimeIntervalError.textContent = "";
    runtimeIntervalError.classList.add("hidden");
    return;
  }

  const intervals = normalizeAnalysisIntervalRules(profile.rules);
  const phase = getAnalysisPhase(state);
  const activeRule = getActiveAnalysisIntervalRule(state, profile.rules);
  const recommendationKey = getIntervalRecommendationKey(new Date());
  populateIntervalSelects({
    entrySelect: runtimeEntryIntervalSelect,
    pendingSelect: runtimePendingIntervalSelect,
    positionSelect: runtimePositionIntervalSelect
  }, language, intervals);

  runtimeEntryIntervalSelect.disabled = !apiReady || isUpdatingRuntimeIntervals;
  runtimePendingIntervalSelect.disabled = !apiReady || isUpdatingRuntimeIntervals;
  runtimePositionIntervalSelect.disabled = !apiReady || isUpdatingRuntimeIntervals;

  runtimeIntervalStatus.innerHTML = `
    <p><strong>${escapeHtml(t(language, "analysisPhaseLabel"))}:</strong> ${escapeHtml(formatAnalysisPhaseLabel(language, phase))}</p>
    <p><strong>${escapeHtml(t(language, "activeIntervalLabel"))}:</strong> ${escapeHtml(formatAnalysisIntervalLabel(language, activeRule))}</p>
  `;
  runtimeIntervalRecommendation.textContent = t(language, `intervalRecommendation_${recommendationKey}`);
  runtimeIntervalRecommendation.classList.toggle("hidden", false);

  if (!runtimeIntervalError.textContent) {
    runtimeIntervalError.classList.add("hidden");
  }
}

function renderRuntimeSellStrategySection(state, language, apiReady) {
  const profile = state.monitoringProfile || state.lastMonitoringProfile;
  const shouldShow = Boolean(profile) && (state.status === STATUS.RUNNING || state.status === STATUS.PAUSED);
  runtimeSellStrategySection.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) {
    runtimeSellStrategyError.textContent = "";
    runtimeSellStrategyError.classList.add("hidden");
    return;
  }

  const sellRules = normalizeSellStrategyRules(profile.rules);
  safeSetInputValue(runtimeQuickProfitDeltaInput, sellRules.quickProfitDelta, isUpdatingSellStrategy);

  runtimeQuickProfitDeltaInput.disabled = !apiReady || isUpdatingSellStrategy;

  const levels = buildSellStrategyContext(state.virtualPosition, sellRules);
  runtimeSellStrategyStatus.innerHTML = levels
    ? `<p><strong>${escapeHtml(t(language, "quickProfitTrigger"))}:</strong> ${escapeHtml(levels.quickProfitPrice)}</p>`
    : `<p>${escapeHtml(t(language, "sellStrategyFlatHint"))}</p>`;

  if (!runtimeSellStrategyError.textContent) {
    runtimeSellStrategyError.classList.add("hidden");
  }
}

async function render() {
  // Ask background to sweep stale (cross-trading-day) virtual positions before we read state.
  // Background handler is a cheap no-op when no position exists or position is same-day.
  // Covers the edge case where Chrome stays open across days with no new monitoring round firing.
  try {
    await chrome.runtime.sendMessage({ type: "check-stale-position" });
  } catch {
    // Service worker may be asleep; the next monitoring round still catches it.
  }

  const state = await getState();
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const apiReady = hasApiKey(settings);

  updateStaticText(language, settings);
  statusBadge.textContent = getStatusBadgeLabel(language, state.status);
  summaryText.textContent = getSummary(state, language);
  apiKeyInput.value = "";
  renderAnalysisCard(state, language);
  renderPositionPanels(state, language);
  renderRecentRounds(state, language);
  renderStatsCard(state, language);
  renderTradeJournal(state, language);
  apiSetupSection.classList.toggle("hidden", apiReady);
  renderRuntimeIntervalSection(state, language, apiReady);
  renderRuntimeSellStrategySection(state, language, apiReady);
  renderMarketContextSection(state, language, apiReady);

  const hasSavedSession = hasSavedMonitoringSession(state);
  const isBusy = state.status === STATUS.RUNNING || state.status === STATUS.VALIDATING || isStartingMonitoring;

  stopMonitorButton.disabled = !isBusy;
  continueMonitorButton.disabled = !apiReady || state.status === STATUS.RUNNING || !hasSavedSession;
  exitMonitorButton.disabled = isStartingMonitoring;
  exitMonitorButton.title = "";
  confirmButton.disabled = isStartingMonitoring;

  const marketContextSetupActive = isMarketContextSetupActive(state);
  contextSection.classList.toggle("hidden", state.status !== STATUS.AWAITING_CONTEXT || marketContextSetupActive);
  saveApiKeyButton.disabled = false;
  clearApiKeyButton.disabled = false;

  if (state.status === STATUS.AWAITING_CONTEXT && !marketContextSetupActive) {
    populateContextForm(state, language);
  }

  if (state.status === STATUS.AWAITING_CONTEXT && !apiReady) {
    summaryText.textContent = t(language, "saveKeyFirst");
  }

  formError.textContent = "";
  formError.classList.add("hidden");
}

stopMonitorButton.addEventListener("click", async () => {
  stopMonitorButton.disabled = true;
  await chrome.runtime.sendMessage({ type: "stop-monitoring" });
  await render();
});

continueMonitorButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  continueMonitorButton.disabled = true;
  summaryText.textContent = t(language, "continuingSession");
  isStartingMonitoring = true;

  const state = await getState();
  renderAnalysisCard({ ...state, status: STATUS.RUNNING }, language);

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "continue-monitoring" });
  } finally {
    isStartingMonitoring = false;
  }

  if (!response?.ok) {
    summaryText.textContent = response?.error || t(language, "couldNotContinue");
  }

  await render();
});

markLimitPlacedButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  markLimitPlacedError.classList.add("hidden");
  markLimitPlacedError.textContent = "";
  const limitPrice = limitPlacedPriceInput.value.trim();
  if (!limitPrice || Number(limitPrice) <= 0) {
    markLimitPlacedError.textContent = t(language, "limitPriceInvalid");
    markLimitPlacedError.classList.remove("hidden");
    return;
  }
  markLimitPlacedButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "mark-limit-placed", limitPrice });
    if (!response?.ok) {
      markLimitPlacedError.textContent = response?.error || t(language, "couldNotStart");
      markLimitPlacedError.classList.remove("hidden");
    } else {
      limitPlacedPriceInput.value = "";
    }
  } finally {
    markLimitPlacedButton.disabled = false;
  }
  await render();
});

pendingLimitCancelButton.addEventListener("click", async () => {
  pendingLimitError.classList.add("hidden");
  pendingLimitError.textContent = "";
  pendingLimitCancelButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "mark-limit-cancelled" });
    if (!response?.ok) {
      pendingLimitError.textContent = response?.error || "";
      pendingLimitError.classList.remove("hidden");
    }
  } finally {
    pendingLimitCancelButton.disabled = false;
  }
  await render();
});

pendingLimitFilledButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  pendingLimitError.classList.add("hidden");
  pendingLimitError.textContent = "";

  const state = await getState();
  const pending = state.pendingLimitOrder;
  if (!pending) {
    await render();
    return;
  }

  const price = pending.limitPrice;
  if (!price || Number(price) <= 0) {
    pendingLimitError.textContent = t(language, "limitPriceInvalid");
    pendingLimitError.classList.remove("hidden");
    return;
  }

  pendingLimitFilledButton.disabled = true;
  try {
    const type = pending.action === "BUY_LIMIT" ? "mark-bought" : "mark-sold";
    const payload = type === "mark-bought" ? { entryPrice: price } : { exitPrice: price };
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) {
      pendingLimitError.textContent =
        response?.error || t(language, type === "mark-bought" ? "couldNotMarkBought" : "couldNotMarkSold");
      pendingLimitError.classList.remove("hidden");
    }
  } finally {
    pendingLimitFilledButton.disabled = false;
  }
  await render();
});

markSoldButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  positionError.classList.add("hidden");
  positionError.textContent = "";
  const exitPrice = exitPriceInput.value.trim();
  if (!exitPrice || Number(exitPrice) <= 0) {
    positionError.textContent = t(language, "exitPriceInvalid");
    positionError.classList.remove("hidden");
    return;
  }
  markSoldButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "mark-sold", exitPrice });
    if (!response?.ok) {
      positionError.textContent = response?.error || t(language, "couldNotMarkSold");
      positionError.classList.remove("hidden");
    } else {
      exitPriceInput.value = "";
    }
  } finally {
    markSoldButton.disabled = false;
  }
  await render();
});

exitMonitorButton.addEventListener("click", async () => {
  exitMonitorButton.disabled = true;
  await chrome.runtime.sendMessage({ type: "exit-monitoring" });
  window.close();
});

saveApiKeyButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const nextKey = apiKeyInput.value.trim();

  if (!nextKey) {
    apiKeyStatus.textContent = t(language, "enterApiKeyFirst");
    return;
  }

  saveApiKeyButton.disabled = true;
  clearApiKeyButton.disabled = true;

  await patchSettings({ openaiApiKey: nextKey, model: "gpt-5.4" });

  apiKeyStatus.textContent = t(language, "apiKeyReady");
  apiKeyInput.value = "";
  await render();
});

clearApiKeyButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  saveApiKeyButton.disabled = true;
  clearApiKeyButton.disabled = true;

  await patchSettings({ openaiApiKey: "", model: "gpt-5.4" });

  apiKeyStatus.textContent = t(language, "apiKeyCleared");
  apiKeyInput.value = "";
  await render();
});

async function runMarketContextScan(timeframe) {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  marketContextError.textContent = "";
  marketContextError.classList.add("hidden");
  scanningMarketContextTimeframe = timeframe;
  await render();

  try {
    const response = await chrome.runtime.sendMessage({ type: "scan-market-context", timeframe });
    if (!response?.ok) {
      marketContextError.textContent = response?.error || t(language, "couldNotScanMarketContext");
      marketContextError.classList.remove("hidden");
    }
  } finally {
    scanningMarketContextTimeframe = null;
  }

  await render();
}

scanDailyContextButton.addEventListener("click", async () => {
  await runMarketContextScan("daily");
});

scanHourlyContextButton.addEventListener("click", async () => {
  await runMarketContextScan("1h");
});

confirmMarketContextButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const initialPosition = getInitialPositionSelection();
  marketContextError.textContent = "";
  marketContextError.classList.add("hidden");

  if (!initialPosition.entryPriceValid) {
    marketContextError.textContent = t(language, "initialEntryPriceInvalid");
    marketContextError.classList.remove("hidden");
    await render();
    return;
  }

  isConfirmingMarketContext = true;
  await render();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "confirm-market-context",
      initialPositionMode: initialPosition.mode,
      initialEntryPrice: initialPosition.entryPrice
    });
    if (!response?.ok) {
      marketContextError.textContent = response?.error || t(language, "marketContextNotComplete");
      marketContextError.classList.remove("hidden");
    }
  } finally {
    isConfirmingMarketContext = false;
  }

  await render();
});

for (const radio of [initialPositionFlatRadio, initialPositionHoldingRadio]) {
  radio.addEventListener("change", () => {
    initialPositionMode = initialPositionHoldingRadio.checked ? "holding" : "flat";
    marketContextError.textContent = "";
    marketContextError.classList.add("hidden");
    void render();
  });
}

initialEntryPriceInput.addEventListener("input", () => {
  void render();
});

async function updateRuntimeIntervals() {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const nextEntryInterval = runtimeEntryIntervalSelect.value;
  const nextPendingInterval = runtimePendingIntervalSelect.value;
  const nextPositionInterval = runtimePositionIntervalSelect.value;
  runtimeIntervalError.textContent = "";
  runtimeIntervalError.classList.add("hidden");
  isUpdatingRuntimeIntervals = true;
  await render();

  let response;
  let sendError = null;
  try {
    response = await chrome.runtime.sendMessage({
      type: "update-analysis-intervals",
      entryInterval: nextEntryInterval,
      pendingInterval: nextPendingInterval,
      positionInterval: nextPositionInterval
    });
  } catch (error) {
    sendError = error;
  } finally {
    isUpdatingRuntimeIntervals = false;
  }

  if (sendError || !response?.ok) {
    runtimeIntervalError.textContent = sendError?.message || response?.error || t(language, "couldNotUpdateIntervals");
    runtimeIntervalError.classList.remove("hidden");
  }

  await render();
}

for (const select of [runtimeEntryIntervalSelect, runtimePendingIntervalSelect, runtimePositionIntervalSelect]) {
  select.addEventListener("change", () => {
    void updateRuntimeIntervals();
  });
}

async function updateRuntimeSellStrategy() {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const quickProfitDelta = runtimeQuickProfitDeltaInput.value;
  runtimeSellStrategyError.textContent = "";
  runtimeSellStrategyError.classList.add("hidden");
  isUpdatingSellStrategy = true;
  await render();

  let response;
  let sendError = null;
  try {
    response = await chrome.runtime.sendMessage({
      type: "update-sell-strategy",
      quickProfitDelta
    });
  } catch (error) {
    sendError = error;
  } finally {
    isUpdatingSellStrategy = false;
  }

  if (sendError || !response?.ok) {
    runtimeSellStrategyError.textContent = sendError?.message || response?.error || t(language, "couldNotUpdateSellStrategy");
    runtimeSellStrategyError.classList.remove("hidden");
  }

  await render();
}

runtimeQuickProfitDeltaInput.addEventListener("change", () => {
  void updateRuntimeSellStrategy();
});

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

contextForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const settings = await getSettings();
  const language = getLanguage(settings.language);

  if (!hasApiKey(settings)) {
    formError.textContent = t(language, "saveApiKeyBeforeMonitoring");
    formError.classList.remove("hidden");
    return;
  }

  if (!contextForm.reportValidity()) {
    return;
  }

  confirmButton.disabled = true;
  formError.textContent = "";
  formError.classList.add("hidden");
  summaryText.textContent = t(language, "startMonitoringProgress");
  isStartingMonitoring = true;

  const state = await getState();
  renderAnalysisCard({ ...state, status: STATUS.RUNNING }, language);

  let response;
  let sendError = null;

  try {
    response = await chrome.runtime.sendMessage({
      type: "start-monitoring",
      symbolOverride: symbolOverrideInput.value,
      entryInterval: entryIntervalSelect.value,
      pendingInterval: pendingIntervalSelect.value,
      positionInterval: positionIntervalSelect.value,
      quickProfitDelta: quickProfitDeltaInput.value
    });
  } catch (error) {
    sendError = error;
  } finally {
    isStartingMonitoring = false;
  }

  if (sendError || !response?.ok) {
    formError.textContent = sendError?.message || response?.error || t(language, "couldNotStart");
    formError.classList.remove("hidden");
    confirmButton.disabled = false;
    await render();
    return;
  }

  await render();
});

const debouncedRender = debounce(() => {
  void render();
}, 100);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes.monitorState && !changes.appSettings) return;
  debouncedRender();
});

void render();
