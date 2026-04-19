import { ANALYSIS_INTERVAL_OPTIONS, DEFAULT_TOTAL_ROUNDS, STATUS, TOTAL_ROUNDS_OPTIONS } from "./lib/constants.js";
import { getLanguage, t } from "./lib/i18n.js";
import { getSettings, getState, patchSettings } from "./lib/storage.js";

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
const positionSection = document.getElementById("positionSection");
const positionSectionHeaderTitle = document.getElementById("positionSectionHeaderTitle");
const positionSectionHeaderCopy = document.getElementById("positionSectionHeaderCopy");
const positionSummary = document.getElementById("positionSummary");
const positionActions = document.getElementById("positionActions");
const exitPriceLabelSpan = document.getElementById("exitPriceLabel");
const exitPriceInput = document.getElementById("exitPriceInput");
const markSoldButton = document.getElementById("markSoldButton");
const positionError = document.getElementById("positionError");
const markBoughtSection = document.getElementById("markBoughtSection");
const markBoughtTitle = document.getElementById("markBoughtTitle");
const markBoughtCopy = document.getElementById("markBoughtCopy");
const entryPriceLabelSpan = document.getElementById("entryPriceLabel");
const entryPriceInput = document.getElementById("entryPriceInput");
const markBoughtButton = document.getElementById("markBoughtButton");
const markBoughtError = document.getElementById("markBoughtError");

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
  if (action === "BUY_NOW" || action === "BUY_LIMIT") {
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

function renderPositionPanels(state, language) {
  const position = state.virtualPosition;
  const lastAction = state.lastResult?.analysis?.action;
  const isRunning = state.status === STATUS.RUNNING;

  positionSectionHeaderTitle.textContent = t(language, "virtualPositionTitle");
  positionSectionHeaderCopy.textContent = t(language, "virtualPositionCopy");
  exitPriceLabelSpan.textContent = t(language, "exitPriceLabel");
  markSoldButton.textContent = t(language, "markSoldButton");
  markBoughtTitle.textContent = t(language, "markBoughtTitle");
  markBoughtCopy.textContent = t(language, "markBoughtCopy");
  entryPriceLabelSpan.textContent = t(language, "entryPriceLabel");
  markBoughtButton.textContent = t(language, "markBoughtButton");

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
    markBoughtSection.classList.add("hidden");
    return;
  }

  positionSection.classList.add("hidden");

  const canMarkBought = isRunning && (lastAction === "BUY_NOW" || lastAction === "BUY_LIMIT");
  markBoughtSection.classList.toggle("hidden", !canMarkBought);

  if (canMarkBought) {
    const suggested = state.lastResult?.analysis?.entryPrice || "";
    if (suggested && !entryPriceInput.value) {
      entryPriceInput.value = suggested;
    }
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
  apiSetupSection.classList.toggle("hidden", apiReady);

  const hasSavedSession = hasSavedMonitoringSession(state);
  const isBusy = state.status === STATUS.RUNNING || state.status === STATUS.VALIDATING || isStartingMonitoring;

  stopMonitorButton.disabled = !isBusy;
  continueMonitorButton.disabled = !apiReady || state.status === STATUS.RUNNING || !hasSavedSession;
  restartMonitorButton.disabled = !apiReady || !hasSavedSession;
  exitMonitorButton.disabled = isStartingMonitoring;
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

markBoughtButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  markBoughtError.classList.add("hidden");
  markBoughtError.textContent = "";
  const entryPrice = entryPriceInput.value.trim();
  if (!entryPrice || Number(entryPrice) <= 0) {
    markBoughtError.textContent = t(language, "entryPriceInvalid");
    markBoughtError.classList.remove("hidden");
    return;
  }
  markBoughtButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "mark-bought", entryPrice });
    if (!response?.ok) {
      markBoughtError.textContent = response?.error || t(language, "couldNotMarkBought");
      markBoughtError.classList.remove("hidden");
    } else {
      entryPriceInput.value = "";
    }
  } finally {
    markBoughtButton.disabled = false;
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
