import { AUTO_STOP_OPTIONS, RISK_STYLE_OPTIONS, STATUS } from "./lib/constants.js";
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
const contextForm = document.getElementById("contextForm");
const positionSectionTitle = document.getElementById("positionSectionTitle");
const positionSectionCopy = document.getElementById("positionSectionCopy");
const currentSharesLabel = document.getElementById("currentSharesLabel");
const averageCostLabel = document.getElementById("averageCostLabel");
const availableCashLabel = document.getElementById("availableCashLabel");
const allowAveragingDownLabel = document.getElementById("allowAveragingDownLabel");
const allowSellSideActionsLabel = document.getElementById("allowSellSideActionsLabel");
const rulesSectionTitle = document.getElementById("rulesSectionTitle");
const rulesSectionCopy = document.getElementById("rulesSectionCopy");
const buyRiskStyleLabel = document.getElementById("buyRiskStyleLabel");
const sellRiskStyleLabel = document.getElementById("sellRiskStyleLabel");
const autoStopLabel = document.getElementById("autoStopLabel");
const currentSharesInput = document.getElementById("currentSharesInput");
const averageCostInput = document.getElementById("averageCostInput");
const availableCashInput = document.getElementById("availableCashInput");
const allowAveragingDownSelect = document.getElementById("allowAveragingDownSelect");
const allowSellSideActionsSelect = document.getElementById("allowSellSideActionsSelect");
const buyRiskStyleSelect = document.getElementById("buyRiskStyleSelect");
const sellRiskStyleSelect = document.getElementById("sellRiskStyleSelect");
const autoStopSelect = document.getElementById("autoStopSelect");
const formHint = document.getElementById("formHint");
const formError = document.getElementById("formError");
const confirmButton = document.getElementById("confirmButton");
const recommendationTitle = document.getElementById("recommendationTitle");
const analysisCard = document.getElementById("analysisCard");

let isStartingMonitoring = false;

function escapeHtml(value) {
  return `${value}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPrice(value) {
  return value && value !== "N/A" ? value : null;
}

function formatActionLabel(language, action) {
  return action ? t(language, `action_${action}`) : t(language, "unknown");
}

function formatBooleanLabel(language, value) {
  return value ? t(language, "yes") : t(language, "no");
}

function normalizeRiskStyleValue(value) {
  if (value === "aggressive" || value === "moderate" || value === "conservative") {
    return value;
  }

  return "conservative";
}



function normalizeAutoStopRule(value) {
  return AUTO_STOP_OPTIONS.some((option) => option.value === value) ? value : "30m";
}

function formatAutoStopLabel(language, value) {
  return t(language, `autoStop_${normalizeAutoStopRule(value)}`);
}


function getClarityLabel(language, value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return t(language, "clarityUnknown");
  }

  if (value < 35) {
    return t(language, "clarityLow");
  }

  if (value < 70) {
    return t(language, "clarityMedium");
  }

  return t(language, "clarityHigh");
}

function getPrimaryLevel(analysis) {
  return formatPrice(analysis.levels?.entry) || formatPrice(analysis.limitPrice);
}

function getOrderPlanLabel(language, analysis) {
  if (analysis.orderType === "LIMIT" && formatPrice(analysis.limitPrice)) {
    return t(language, "orderPlanLimit", { price: analysis.limitPrice });
  }

  return t(language, "orderPlanNone");
}


function renderOrderGuidanceCard(language, side, guidance) {
  const normalizedGuidance = guidance || {};

  return `
    <article class="metric-card order-guidance-card full-span">
      <div class="order-guidance-header">
        <p class="metric-label">${escapeHtml(getPlainOrderTitle(language, side))}</p>
        <span class="order-guidance-badge">${escapeHtml(getStaticOrderBadgeLabel(language))}</span>
      </div>
      <div class="order-guidance-grid">
        <div>
          <p class="metric-label">${escapeHtml(getPlainOrderMetaLabel(language, "price"))}</p>
          <p class="metric-value">${escapeHtml(normalizedGuidance.price || t(language, "nA"))}</p>
        </div>
        <div>
          <p class="metric-label">${escapeHtml(getPlainOrderMetaLabel(language, "shares"))}</p>
          <p class="metric-value">${escapeHtml(normalizedGuidance.shares || t(language, "nA"))}</p>
        </div>
      </div>
      <div class="order-guidance-reason">
        <p class="metric-label">${escapeHtml(getPlainOrderReasonLabel(language))}</p>
        <p class="metric-value">${escapeHtml(normalizedGuidance.reason || t(language, "nA"))}</p>
      </div>
    </article>
  `;
}


function getWhatToDoNowCopy(language, analysis) {
  if (analysis.whatToDoNow) {
    return analysis.whatToDoNow;
  }

  return buildActionCopy(language, analysis);
}

function buildActionCopy(language, analysis) {
  const level = getPrimaryLevel(analysis);

  if (analysis.action === "OPEN") {
    return level ? t(language, "openActionCopy", { price: level }) : t(language, "openActionNoPrice");
  }

  if (analysis.action === "ADD") {
    return level ? t(language, "addActionCopy", { price: level }) : t(language, "addActionNoPrice");
  }

  if (analysis.action === "HOLD") {
    return level ? t(language, "holdActionCopy", { price: level }) : t(language, "holdActionNoPrice");
  }

  if (analysis.action === "REDUCE") {
    return level ? t(language, "reduceActionCopy", { price: level }) : t(language, "reduceActionNoPrice");
  }

  if (analysis.action === "EXIT") {
    return level ? t(language, "exitActionCopy", { price: level }) : t(language, "exitActionNoPrice");
  }

  return level ? t(language, "waitActionCopy", { price: level }) : t(language, "waitActionNoPrice");
}


function getActionTone(action) {
  if (action === "OPEN" || action === "ADD") {
    return "buy";
  }

  if (action === "REDUCE" || action === "EXIT") {
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

function renderAnalysisCard(state, language) {
  const result = state.lastResult;
  const analysis = result?.analysis;
  const profile = result?.monitoringProfile;

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
  const levels = analysis.levels || {};
  const action = formatActionLabel(language, analysis.action);
  const orderPlan = getOrderPlanLabel(language, analysis);

  analysisCard.className = "analysis-card";
  analysisCard.innerHTML = `
    <section class="signal-banner ${tone}">
      <div class="signal-topline">
        <div>
          <p class="signal-label">${escapeHtml(t(language, "actionNow"))}</p>
          <h3 class="signal-value">${escapeHtml(action)}</h3>
        </div>
        <span class="pill">${escapeHtml(orderPlan)}</span>
      </div>
      <div class="guidance-grid">
        ${renderGuidanceCard(t(language, "whatToDoNow"), getWhatToDoNowCopy(language, analysis))}
      </div>
    </section>
    <div class="analysis-grid">
      ${renderMetricCard(language, getSafeCurrentPriceLabel(language), analysis.currentPrice || t(language, "nA"))}
      ${renderMetricCard(language, getPlainResultLabel(language, "supportLevels"), analysis.supportLevels || levels.entry || t(language, "nA"))}
      ${renderMetricCard(language, getPlainResultLabel(language, "resistanceLevels"), analysis.resistanceLevels || levels.target || t(language, "nA"))}
      ${renderMetricCard(language, getPlainResultLabel(language, "riskTrigger"), levels.invalidation || t(language, "nA"))}
      ${renderMetricCard(language, t(language, "suggestedSize"), analysis.sizeSuggestion || t(language, "nA"))}
      ${renderOrderGuidanceCard(language, "buy", analysis.buyOrderGuidance)}
      ${renderOrderGuidanceCard(language, "sell", analysis.sellOrderGuidance)}
      ${renderMetricCard(language, getPlainResultLabel(language, "riskNote"), analysis.riskNote || t(language, "nA"), true)}
    </div>
  `;
}



function getBuyRiskStyleLabel(language) {
  return t(language, "buyRiskStyle");
}

function getSellRiskStyleLabel(language) {
  return t(language, "sellRiskStyle");
}

function getMonitoringDetailCopy(language, round) {
  return t(language, "monitoringDetail", { round });
}

function getStaticOrderBadgeLabel(language) {
  return t(language, "referenceOnly");
}

function getPlainOrderTitle(language, side) {
  return side === "buy" ? t(language, "buyReference") : t(language, "sellReference");
}

function getPlainOrderMetaLabel(language, key) {
  const labels = {
    price: t(language, "referencePrice"),
    shares: t(language, "referenceShares")
  };

  return labels[key] || key;
}

function getPlainResultLabel(language, key) {
  const labels = {
    supportLevels: t(language, "currentSupport"),
    resistanceLevels: t(language, "currentResistance"),
    riskTrigger: t(language, "riskTrigger"),
    riskNote: t(language, "watchOut")
  };

  return labels[key] || t(language, key);
}

function getPlainOrderReasonLabel(language) {
  return t(language, "simpleWhy");
}

function getPanelSectionTitle(language, section) {
  const labels = {
    position: t(language, "positionCapitalStatus"),
    rules: t(language, "executionRules")
  };

  return labels[section] || section;
}

function getPanelSectionCopy(language, section) {
  const labels = {
    position: t(language, "positionCapitalStatusCopy"),
    rules: t(language, "executionRulesCopy")
  };

  return labels[section] || "";
}

function getContextCardTitle(language) {
  return t(language, "tradingSetup");
}

function getContextCardCopy(language) {
  return t(language, "tradingSetupCopy");
}

function getSafeSellSideActionsLabel(language) {
  return t(language, "allowSellSideActions");
}

function getSafeCurrentPriceLabel(language) {
  return t(language, "currentPrice");
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
  contextTitle.textContent = getContextCardTitle(language);
  contextDescription.textContent = getContextCardCopy(language);
  positionSectionTitle.textContent = getPanelSectionTitle(language, "position");
  positionSectionCopy.textContent = getPanelSectionCopy(language, "position");
  currentSharesLabel.textContent = t(language, "currentShares");
  averageCostLabel.textContent = t(language, "averageCost");
  availableCashLabel.textContent = t(language, "availableCash");
  rulesSectionTitle.textContent = getPanelSectionTitle(language, "rules");
  rulesSectionCopy.textContent = getPanelSectionCopy(language, "rules");
  allowAveragingDownLabel.textContent = t(language, "allowAveragingDown");
  allowSellSideActionsLabel.textContent = getSafeSellSideActionsLabel(language);
  buyRiskStyleLabel.textContent = getBuyRiskStyleLabel(language);
  sellRiskStyleLabel.textContent = getSellRiskStyleLabel(language);
  autoStopLabel.textContent = t(language, "autoStop");
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

  if (state.status === STATUS.RUNNING) {
    const base = getMonitoringDetailCopy(language, state.roundCount);
    const autoStopRule = normalizeAutoStopRule(
      state.monitoringProfile?.rules?.autoStopRule || state.lastMonitoringProfile?.rules?.autoStopRule
    );

    return `${base} ${t(language, "autoStop")}: ${formatAutoStopLabel(language, autoStopRule)}.`;
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

function populateBooleanSelect(select, language, selectedValue) {
  select.innerHTML = `
    <option value="yes">${escapeHtml(t(language, "yes"))}</option>
    <option value="no">${escapeHtml(t(language, "no"))}</option>
  `;
  select.value = selectedValue ? "yes" : "no";
}

function populateRiskStyleOptions(select, language, selectedValue = "conservative") {
  select.innerHTML = RISK_STYLE_OPTIONS
    .map((option) => `<option value="${option.value}">${escapeHtml(t(language, `riskStyle_${option.value}`))}</option>`)
    .join("");
  select.value = selectedValue;
}

function populateAutoStopOptions(language, selectedValue = "30m") {
  autoStopSelect.innerHTML = AUTO_STOP_OPTIONS
    .map((option) => `<option value="${option.value}">${escapeHtml(t(language, `autoStop_${option.value}`))}</option>`)
    .join("");
  autoStopSelect.value = normalizeAutoStopRule(selectedValue);
}

function updateFormGuidance(language) {
  const currentShares = Number(currentSharesInput.value || 0);
  const hasPosition = Number.isFinite(currentShares) && currentShares > 0;

  averageCostInput.required = hasPosition;
  formHint.textContent = t(language, "constraintsHint");
}

function populateContextForm(state, language) {
  const profile = state.monitoringProfile || state.lastMonitoringProfile;
  const buyRiskStyle = normalizeRiskStyleValue(profile?.rules?.buyRiskStyle);
  const sellRiskStyle = normalizeRiskStyleValue(profile?.rules?.sellRiskStyle);
  const allowSellSideActions = profile?.rules?.allowSellSideActions ?? true;

  currentSharesInput.value = profile?.positionContext?.currentShares ?? "";
  averageCostInput.value = profile?.positionContext?.averageCost ?? "";
  availableCashInput.value = profile?.capitalContext?.availableCash ?? "";
  populateBooleanSelect(allowAveragingDownSelect, language, Boolean(profile?.rules?.allowAveragingDown));
  populateBooleanSelect(allowSellSideActionsSelect, language, allowSellSideActions);
  populateRiskStyleOptions(buyRiskStyleSelect, language, buyRiskStyle);
  populateRiskStyleOptions(sellRiskStyleSelect, language, sellRiskStyle);
  populateAutoStopOptions(language, normalizeAutoStopRule(profile?.rules?.autoStopRule));
  updateFormGuidance(language);
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

  await chrome.runtime.sendMessage({
    type: "stop-monitoring"
  });

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
  renderAnalysisCard({
    ...state,
    status: STATUS.RUNNING
  }, language);

  let response;

  try {
    response = await chrome.runtime.sendMessage({
      type: "continue-monitoring"
    });
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
  renderAnalysisCard({
    ...state,
    status: STATUS.RUNNING,
    roundCount: 0,
    lastResult: null
  }, language);

  let response;

  try {
    response = await chrome.runtime.sendMessage({
      type: "restart-monitoring"
    });
  } finally {
    isStartingMonitoring = false;
  }

  if (!response?.ok) {
    summaryText.textContent = response?.error || t(language, "couldNotRestart");
  }

  await render();
});

exitMonitorButton.addEventListener("click", async () => {
  exitMonitorButton.disabled = true;

  await chrome.runtime.sendMessage({
    type: "exit-monitoring"
  });

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

  await patchSettings({
    openaiApiKey: nextKey,
    model: "gpt-5.4"
  });

  apiKeyStatus.textContent = t(language, "apiKeyReady");
  apiKeyInput.value = "";
  await render();
});

clearApiKeyButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  saveApiKeyButton.disabled = true;
  clearApiKeyButton.disabled = true;

  await patchSettings({
    openaiApiKey: "",
    model: "gpt-5.4"
  });

  apiKeyStatus.textContent = t(language, "apiKeyCleared");
  apiKeyInput.value = "";
  await render();
});

currentSharesInput.addEventListener("input", async () => {
  const settings = await getSettings();
  updateFormGuidance(getLanguage(settings.language));
});

contextForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const settings = await getSettings();
  const language = getLanguage(settings.language);

  if (!hasApiKey(settings)) {
    formError.textContent = t(language, "saveApiKeyBeforeMonitoring");
    formError.classList.remove("hidden");
    return;
  }

  updateFormGuidance(language);

  if (!contextForm.reportValidity()) {
    return;
  }

  confirmButton.disabled = true;
  formError.textContent = "";
  formError.classList.add("hidden");
  summaryText.textContent = t(language, "startMonitoringProgress");
  isStartingMonitoring = true;

  const state = await getState();
  renderAnalysisCard({
    ...state,
    status: STATUS.RUNNING
  }, language);

  let response;

  try {
    response = await chrome.runtime.sendMessage({
      type: "start-monitoring",
      currentShares: currentSharesInput.value,
      averageCost: averageCostInput.value,
      availableCash: availableCashInput.value,
      allowAveragingDown: allowAveragingDownSelect.value === "yes",
      allowSellSideActions: allowSellSideActionsSelect.value === "yes",
      buyRiskStyle: buyRiskStyleSelect.value,
      sellRiskStyle: sellRiskStyleSelect.value,
      autoStopRule: autoStopSelect.value
    });
  } finally {
    isStartingMonitoring = false;
  }

  if (!response?.ok) {
    formError.textContent = response?.error || t(language, "couldNotStart");
    formError.classList.remove("hidden");
    confirmButton.disabled = false;
    return;
  }

  await render();
});

chrome.storage.onChanged.addListener(async () => {
  await render();
});

void render();
