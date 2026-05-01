import { ANALYSIS_INTERVAL_OPTIONS, DEFAULT_TOTAL_ROUNDS, STATUS, TOTAL_ROUNDS_OPTIONS } from "./lib/constants.js";
import { getLanguage, t } from "./lib/i18n.js";
import { getSettings, getState, patchSettings } from "./lib/storage.js";
import { ACTION_BUCKETS, CONFIDENCE_BUCKETS, computeTradeStats } from "./lib/trade-stats.js";

const SMALL_SAMPLE_THRESHOLD = 5;

const heroEyebrow = document.getElementById("heroEyebrow");
const heroTitle = document.getElementById("heroTitle");
const statusBadge = document.getElementById("statusBadge");
const summaryText = document.getElementById("summaryText");
const apiSetupSection = document.getElementById("apiSetupSection");
const stopMonitorButton = document.getElementById("stopMonitorButton");
const continueMonitorButton = document.getElementById("continueMonitorButton");
const restartMonitorButton = document.getElementById("restartMonitorButton");
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
const analysisIntervalLabel = document.getElementById("analysisIntervalLabel");
const totalRoundsLabel = document.getElementById("totalRoundsLabel");
const analysisIntervalSelect = document.getElementById("analysisIntervalSelect");
const totalRoundsSelect = document.getElementById("totalRoundsSelect");
const formError = document.getElementById("formError");
const confirmButton = document.getElementById("confirmButton");
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
// Long-term context form widget (visible inside the start form)
const longTermFormSection = document.getElementById("longTermFormSection");
const longTermFormLabel = document.getElementById("longTermFormLabel");
const longTermFormCopy = document.getElementById("longTermFormCopy");
const longTermFormTimeframeLabel = document.getElementById("longTermFormTimeframeLabel");
const longTermFormTimeframeSelect = document.getElementById("longTermFormTimeframeSelect");
const longTermFormGenerateButton = document.getElementById("longTermFormGenerateButton");
const longTermFormSummary = document.getElementById("longTermFormSummary");
const longTermFormError = document.getElementById("longTermFormError");
const LONG_TERM_TIMEFRAME_OPTIONS = ["daily", "weekly"];
let isGeneratingLongTerm = false;

const STALE_LIMIT_THRESHOLD_MINUTES = 10;

let isStartingMonitoring = false;

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

function formatConfidenceLabel(language, confidence) {
  if (!confidence) return t(language, "unknown");
  const key = `confidence_${confidence}`;
  const label = t(language, key);
  return label === key ? confidence : label;
}

function normalizeAnalysisInterval(value) {
  return ANALYSIS_INTERVAL_OPTIONS.some((option) => option.value === value) ? value : "5m";
}

function normalizeTotalRounds(value) {
  return TOTAL_ROUNDS_OPTIONS.some((option) => option.value === `${value}`) ? `${value}` : `${DEFAULT_TOTAL_ROUNDS}`;
}

function formatAnalysisIntervalLabel(language, value) {
  return t(language, `analysisInterval_${normalizeAnalysisInterval(value)}`);
}

function formatTotalRoundsLabel(language, value) {
  return t(language, `totalRounds_${normalizeTotalRounds(value)}`);
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

function renderMetricCard(language, label, value, fullSpan = false) {
  return `
    <article class="metric-card${fullSpan ? " full-span" : ""}">
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
  const result = state.lastResult;
  const analysis = result?.analysis;

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
  const action = formatActionLabel(language, analysis.action);
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
        ${renderGuidanceCard(t(language, "triggerConditionLabel"), analysis.triggerCondition || nA)}
      </div>
    </section>
    <div class="analysis-grid">
      ${renderMetricCard(language, t(language, "currentPrice"), analysis.currentPrice || nA)}
      ${renderMetricCard(language, t(language, "entryPriceLabel"), analysis.entryPrice || nA)}
      ${renderMetricCard(language, t(language, "stopLossPriceLabel"), analysis.stopLossPrice || nA)}
      ${renderMetricCard(language, t(language, "targetPriceLabel"), analysis.targetPrice || nA)}
      ${renderMetricCard(language, t(language, "confidenceLabel"), formatConfidenceLabel(language, analysis.confidence))}
      ${renderMetricCard(language, t(language, "reasoningLabel"), analysis.reasoning || nA, true)}
    </div>
  `;
}

function getMonitoringDetailCopy(language, round, interval, totalRounds) {
  return t(language, "monitoringDetail", { round, interval, totalRounds });
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

function renderStatBucket(language, label, bucket, isHeader = false) {
  if (bucket.n === 0) {
    return `
      <div class="stats-row${isHeader ? " stats-row-header" : ""}" data-tone="empty">
        <div class="stats-row-label">${escapeHtml(label)}</div>
        <div class="stats-row-empty">${escapeHtml(t(language, "statsBucketEmpty"))}</div>
      </div>
    `;
  }

  const small = bucket.n < SMALL_SAMPLE_THRESHOLD;
  const warning = small
    ? `<div class="stats-small-sample">⚠ ${escapeHtml(t(language, "statsSmallSampleWarning", { n: bucket.n }))}</div>`
    : "";
  const pnlTone = getPnlTone(bucket.avgPnlPercent);

  return `
    <div class="stats-row${isHeader ? " stats-row-header" : ""}${small ? " stats-row-small" : ""}">
      <div class="stats-row-label">${escapeHtml(label)}</div>
      <div class="stats-row-metrics">
        <span class="stats-metric"><span class="stats-metric-k">${escapeHtml(t(language, "statsSampleSize"))}</span><span class="stats-metric-v">${bucket.n}</span></span>
        <span class="stats-metric"><span class="stats-metric-k">${escapeHtml(t(language, "statsWinRate"))}</span><span class="stats-metric-v">${escapeHtml(formatWinRate(bucket.winRate))}</span></span>
        <span class="stats-metric stats-metric-pnl" data-tone="${pnlTone}"><span class="stats-metric-k">${escapeHtml(t(language, "statsAvgPnl"))}</span><span class="stats-metric-v">${escapeHtml(formatPctSigned(bucket.avgPnlPercent))}</span></span>
      </div>
      ${warning}
    </div>
  `;
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

  const actionRows = ACTION_BUCKETS
    .map((key) => renderStatBucket(language, formatActionLabel(language, key), stats.byAction[key]))
    .join("");
  const actionUnknown = stats.byAction.unknown && stats.byAction.unknown.n > 0
    ? renderStatBucket(language, t(language, "unknown"), stats.byAction.unknown)
    : "";

  const confidenceRows = CONFIDENCE_BUCKETS
    .map((key) => renderStatBucket(language, formatConfidenceLabel(language, key), stats.byConfidence[key]))
    .join("");
  const confidenceUnknown = stats.byConfidence.unknown && stats.byConfidence.unknown.n > 0
    ? renderStatBucket(language, t(language, "unknown"), stats.byConfidence.unknown)
    : "";

  statsContent.innerHTML = `
    <h3 class="stats-heading">${escapeHtml(t(language, "statsOverallHeading"))}</h3>
    ${renderStatsOverall(language, stats.overall)}
    <h3 class="stats-heading">${escapeHtml(t(language, "statsByActionHeading"))}</h3>
    <div class="stats-table">${actionRows}${actionUnknown}</div>
    <h3 class="stats-heading">${escapeHtml(t(language, "statsByConfidenceHeading"))}</h3>
    <div class="stats-table">${confidenceRows}${confidenceUnknown}</div>
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
  const actionLabel = formatActionLabel(language, pending.action);
  const held = minutesSinceIso(pending.placedAt);
  const heldText = Number.isFinite(held) ? `${held}m` : nA;
  pendingLimitSummary.innerHTML = `
    <p class="position-line"><strong>${escapeHtml(t(language, "actionNow"))}:</strong> ${escapeHtml(actionLabel)}</p>
    <p class="position-line"><strong>${escapeHtml(t(language, "symbolOverride"))}:</strong> ${escapeHtml(pending.symbol || nA)}</p>
    <p class="position-line"><strong>${escapeHtml(t(language, "limitPriceLabel"))}:</strong> ${escapeHtml(pending.limitPrice || nA)}</p>
    <p class="position-line"><strong>${escapeHtml(t(language, "stopLossPriceLabel"))}:</strong> ${escapeHtml(pending.stopLossPrice || nA)}</p>
    <p class="position-line"><strong>${escapeHtml(t(language, "targetPriceLabel"))}:</strong> ${escapeHtml(pending.targetPrice || nA)}</p>
    <p class="position-line"><strong>${escapeHtml(t(language, "statsAvgHeld"))}:</strong> ${escapeHtml(heldText)}</p>
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
  const currentEntry = Number(state.lastResult?.analysis?.entryPrice);
  const pendingPriceNum = Number(pending.limitPrice);
  const priceDrift =
    Number.isFinite(pendingPriceNum) && pendingPriceNum > 0 && Number.isFinite(currentEntry)
      ? Math.abs(currentEntry - pendingPriceNum) / pendingPriceNum
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
      currPrice: Number.isFinite(currentEntry) ? currentEntry.toFixed(2) : nA,
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
  markLimitPlacedTitle.textContent = t(language, isBuy ? "markLimitPlacedTitle_buy" : "markLimitPlacedTitle_sell");
  markLimitPlacedCopy.textContent = t(language, "markLimitPlacedCopy");
  limitPlacedPriceLabel.textContent = t(language, "limitPriceLabel");
  markLimitPlacedButton.textContent = t(language, isBuy ? "markLimitPlacedButton_buy" : "markLimitPlacedButton_sell");
  markLimitPlacedButton.className = `mode-button ${isBuy ? "buy-button" : "sell-button"}`;

  // BUY_LIMIT: limit price = entryPrice (where user will buy below current).
  // SELL_LIMIT: limit price = targetPrice (where user takes profit above current).
  //   In EXIT mode the prompt convention is entryPrice echoes the user's
  //   original buy price, while targetPrice carries the actionable sell level.
  const analysis = state.lastResult?.analysis;
  const suggested = (isBuy ? analysis?.entryPrice : analysis?.targetPrice) || "";
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
    positionSummary.innerHTML = `
      <p class="position-line"><strong>${escapeHtml(t(language, "symbolOverride"))}:</strong> ${escapeHtml(position.symbol || nA)}</p>
      <p class="position-line"><strong>${escapeHtml(t(language, "entryPriceLabel"))}:</strong> ${escapeHtml(position.entryPrice || nA)}</p>
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

function populateLongTermTimeframeOptions(selectEl, language, selectedValue = "daily") {
  selectEl.innerHTML = LONG_TERM_TIMEFRAME_OPTIONS
    .map((tf) => `<option value="${tf}">${escapeHtml(t(language, `longTermTimeframe_${tf}`))}</option>`)
    .join("");
  selectEl.value = LONG_TERM_TIMEFRAME_OPTIONS.includes(selectedValue) ? selectedValue : "daily";
}

function formatLongTermTimestamp(iso, language) {
  if (!iso) return t(language, "nA");
  try {
    return new Date(iso).toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
      month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    });
  } catch {
    return iso;
  }
}

function renderLongTermSummaryInto(containerEl, ctx, language, { isLoading = false } = {}) {
  if (isLoading) {
    containerEl.classList.remove("hidden");
    containerEl.classList.add("is-loading");
    containerEl.textContent = t(language, "longTermGenerating");
    return;
  }
  containerEl.classList.remove("is-loading");
  if (!ctx) {
    containerEl.classList.add("hidden");
    containerEl.innerHTML = "";
    return;
  }
  containerEl.classList.remove("hidden");
  const trendKey = `longTermTrend_${ctx.trend || "unclear"}`;
  const stageKey = `longTermStage_${ctx.stage || "unclear"}`;
  const trendLabel = t(language, trendKey);
  const stageLabel = t(language, stageKey);
  const support = (ctx.keySupport || "").trim() || t(language, "nA");
  const resistance = (ctx.keyResistance || "").trim() || t(language, "nA");
  const summary = (ctx.summary || "").trim() || t(language, "nA");
  const tfLabel = t(language, `longTermTimeframe_${ctx.timeframe || "daily"}`);
  const generated = t(language, "longTermGeneratedAt", { when: formatLongTermTimestamp(ctx.generatedAt, language) });

  containerEl.innerHTML = `
    <div class="meta">${escapeHtml(tfLabel)} · ${escapeHtml(generated)}</div>
    <div class="row"><span class="label">${escapeHtml(t(language, "longTermFieldTrend"))}</span><span class="value">${escapeHtml(trendLabel)}</span></div>
    <div class="row"><span class="label">${escapeHtml(t(language, "longTermFieldStage"))}</span><span class="value">${escapeHtml(stageLabel)}</span></div>
    <div class="row"><span class="label">${escapeHtml(t(language, "longTermFieldSupport"))}</span><span class="value">${escapeHtml(support)}</span></div>
    <div class="row"><span class="label">${escapeHtml(t(language, "longTermFieldResistance"))}</span><span class="value">${escapeHtml(resistance)}</span></div>
    <div class="row"><span class="label">${escapeHtml(t(language, "longTermFieldSummary"))}</span><span class="value">${escapeHtml(summary)}</span></div>
  `;
}

function renderLongTermFormWidget(state, language) {
  // Visible only during the AWAITING_CONTEXT phase (the start form).
  if (state.status !== STATUS.AWAITING_CONTEXT) {
    longTermFormSection.classList.add("hidden");
    return;
  }
  longTermFormSection.classList.remove("hidden");
  longTermFormLabel.textContent = t(language, "longTermTitle");
  longTermFormCopy.textContent = t(language, "longTermFormCopy");
  longTermFormTimeframeLabel.textContent = t(language, "longTermTimeframeLabel");
  longTermFormGenerateButton.textContent = isGeneratingLongTerm
    ? t(language, "longTermGenerating")
    : t(language, "longTermGenerateButton");
  longTermFormGenerateButton.disabled = isGeneratingLongTerm;

  if (!longTermFormTimeframeSelect.options.length) {
    populateLongTermTimeframeOptions(longTermFormTimeframeSelect, language, "daily");
  }

  const draft = state.longTermContextDraft || null;
  renderLongTermSummaryInto(longTermFormSummary, draft, language, { isLoading: isGeneratingLongTerm });
  // If there's a draft, sync the timeframe selector to it so a Regenerate keeps it aligned.
  if (draft?.timeframe) {
    longTermFormTimeframeSelect.value = draft.timeframe;
  }
}

function updateStaticText(language, settings) {
  heroEyebrow.textContent = t(language, "liveAnalysis");
  heroTitle.textContent = t(language, "appTitle");
  saveApiKeyButton.textContent = t(language, "saveKey");
  clearApiKeyButton.textContent = t(language, "clearKey");
  stopMonitorButton.textContent = t(language, "stop");
  continueMonitorButton.textContent = t(language, "continue");
  restartMonitorButton.textContent = t(language, "restart");
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
  analysisIntervalLabel.textContent = t(language, "analysisInterval");
  totalRoundsLabel.textContent = t(language, "totalRounds");
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
    return t(language, "fillSetupDetail");
  }

  if (state.status === STATUS.RUNNING && state.isRoundInFlight) {
    return t(language, "analyzingCopy");
  }

  if (state.status === STATUS.RUNNING && state.stopReason) {
    return state.stopReason;
  }

  if (state.status === STATUS.RUNNING) {
    const intervalRule = normalizeAnalysisInterval(
      state.monitoringProfile?.rules?.analysisInterval || state.lastMonitoringProfile?.rules?.analysisInterval
    );
    const totalRounds = normalizeTotalRounds(
      state.monitoringProfile?.rules?.totalRounds || state.lastMonitoringProfile?.rules?.totalRounds
    );

    return getMonitoringDetailCopy(
      language,
      state.roundCount,
      formatAnalysisIntervalLabel(language, intervalRule),
      formatTotalRoundsLabel(language, totalRounds)
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

function populateAnalysisIntervalOptions(language, selectedValue = "5m") {
  analysisIntervalSelect.innerHTML = ANALYSIS_INTERVAL_OPTIONS
    .map((option) => `<option value="${option.value}">${escapeHtml(t(language, `analysisInterval_${option.value}`))}</option>`)
    .join("");
  analysisIntervalSelect.value = normalizeAnalysisInterval(selectedValue);
}

function populateTotalRoundsOptions(language, selectedValue = `${DEFAULT_TOTAL_ROUNDS}`) {
  totalRoundsSelect.innerHTML = TOTAL_ROUNDS_OPTIONS
    .map((option) => `<option value="${option.value}">${escapeHtml(t(language, `totalRounds_${option.value}`))}</option>`)
    .join("");
  totalRoundsSelect.value = normalizeTotalRounds(selectedValue);
}

function populateContextForm(state, language) {
  const profile = state.monitoringProfile || state.lastMonitoringProfile;
  symbolOverrideInput.value = profile?.symbolOverride ?? "";
  populateAnalysisIntervalOptions(language, normalizeAnalysisInterval(profile?.rules?.analysisInterval));
  populateTotalRoundsOptions(language, normalizeTotalRounds(profile?.rules?.totalRounds));
}

async function render() {
  // Ask background to sweep stale (cross-trading-day) virtual positions before we read state.
  // Background handler is a cheap no-op when no position exists or position is same-day.
  // Covers the edge case where Chrome stays open across days with no new monitoring round firing.
  try {
    await chrome.runtime.sendMessage({ type: "check-stale-position" });
  } catch {
    // Service worker may be asleep; the onStartup/runMonitoringRound hooks will still catch it.
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
  renderLongTermFormWidget(state, language);
  renderRecentRounds(state, language);
  renderStatsCard(state, language);
  renderTradeJournal(state, language);
  apiSetupSection.classList.toggle("hidden", apiReady);

  const hasSavedSession = hasSavedMonitoringSession(state);
  const isBusy = state.status === STATUS.RUNNING || state.status === STATUS.VALIDATING || isStartingMonitoring;

  // Block Exit and Restart while there's still untracked broker state on the
  // user's account. virtualPosition = real shares held; pendingLimitOrder =
  // resting order at broker. Either condition means tearing down the session
  // would leave the broker out of sync with the extension's view, and the
  // next AI round would (incorrectly) treat the user as flat. The user must
  // resolve via Mark sold / Cancel limit before exiting or restarting.
  // Stop is still allowed — it pauses but preserves all state for Continue.
  const hasOpenPosition = !!state.virtualPosition;
  const hasPendingLimit = !!state.pendingLimitOrder;
  const sessionEndBlockedReason = hasOpenPosition
    ? t(language, "sessionEndBlockedByPosition")
    : hasPendingLimit
      ? t(language, "sessionEndBlockedByPending")
      : "";
  const sessionEndBlocked = !!sessionEndBlockedReason;

  stopMonitorButton.disabled = !isBusy;
  continueMonitorButton.disabled = !apiReady || state.status === STATUS.RUNNING || !hasSavedSession;
  restartMonitorButton.disabled = !apiReady || !hasSavedSession || sessionEndBlocked;
  exitMonitorButton.disabled = isStartingMonitoring || sessionEndBlocked;

  // Tooltip explains WHY the buttons are disabled — a grey button with no
  // explanation is the kind of thing that has users blaming the extension
  // for being broken.
  restartMonitorButton.title = sessionEndBlockedReason;
  exitMonitorButton.title = sessionEndBlockedReason;
  confirmButton.disabled = isStartingMonitoring;

  contextSection.classList.toggle("hidden", state.status !== STATUS.AWAITING_CONTEXT);
  saveApiKeyButton.disabled = false;
  clearApiKeyButton.disabled = false;

  if (state.status === STATUS.AWAITING_CONTEXT) {
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
  restartMonitorButton.disabled = true;
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

restartMonitorButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  continueMonitorButton.disabled = true;
  restartMonitorButton.disabled = true;
  summaryText.textContent = t(language, "restartingSession");
  isStartingMonitoring = true;

  const state = await getState();
  renderAnalysisCard({ ...state, status: STATUS.RUNNING, roundCount: 0, lastResult: null }, language);

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "restart-monitoring" });
  } finally {
    isStartingMonitoring = false;
  }

  if (!response?.ok) {
    summaryText.textContent = response?.error || t(language, "couldNotRestart");
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

async function runLongTermGenerate({ timeframe, errorEl }) {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  errorEl.textContent = "";
  errorEl.classList.add("hidden");

  isGeneratingLongTerm = true;
  await render();
  try {
    const response = await chrome.runtime.sendMessage({
      type: "generate-long-term-context",
      timeframe
    });
    if (!response?.ok) {
      errorEl.textContent = response?.error || t(language, "longTermGenerateFailed");
      errorEl.classList.remove("hidden");
    }
  } catch (error) {
    errorEl.textContent = error?.message || t(language, "longTermGenerateFailed");
    errorEl.classList.remove("hidden");
  } finally {
    isGeneratingLongTerm = false;
    await render();
  }
}

longTermFormGenerateButton.addEventListener("click", () => {
  void runLongTermGenerate({
    timeframe: longTermFormTimeframeSelect.value || "daily",
    errorEl: longTermFormError
  });
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
      analysisInterval: analysisIntervalSelect.value,
      totalRounds: totalRoundsSelect.value
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
