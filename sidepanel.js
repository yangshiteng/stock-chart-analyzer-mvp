import { INTENT_OPTIONS, MODE, STATUS } from "./lib/constants.js";
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
const modeSection = document.getElementById("modeSection");
const modeSectionTitle = document.getElementById("modeSectionTitle");
const modeSectionCopy = document.getElementById("modeSectionCopy");
const contextSection = document.getElementById("contextSection");
const buyButton = document.getElementById("buyButton");
const sellButton = document.getElementById("sellButton");
const contextTitle = document.getElementById("contextTitle");
const contextDescription = document.getElementById("contextDescription");
const contextForm = document.getElementById("contextForm");
const currentSharesLabel = document.getElementById("currentSharesLabel");
const averageCostLabel = document.getElementById("averageCostLabel");
const intentLabel = document.getElementById("intentLabel");
const currentSharesInput = document.getElementById("currentSharesInput");
const averageCostInput = document.getElementById("averageCostInput");
const intentSelect = document.getElementById("intentSelect");
const formHint = document.getElementById("formHint");
const formError = document.getElementById("formError");
const confirmButton = document.getElementById("confirmButton");
const backButton = document.getElementById("backButton");
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

function formatIntentLabel(language, value) {
  return value ? t(language, `intent_${value}`) : t(language, "notProvided");
}

function formatSignalLabel(value) {
  return value ? value.replaceAll("_", " ") : "N/A";
}

function formatPrice(value) {
  return value && value !== "N/A" ? value : null;
}

function getModeDisplay(language, mode) {
  if (mode === MODE.BUY || mode === "buy") {
    return t(language, "buy");
  }

  if (mode === MODE.SELL || mode === "sell") {
    return t(language, "sell");
  }

  return mode ? `${mode}` : "";
}

function getActionLabel(language, signal) {
  if (signal === "BUY") {
    return t(language, "actionBuy");
  }

  if (signal === "SELL") {
    return t(language, "actionSell");
  }

  if (signal === "WAIT_FOR_CONFIRMATION") {
    return t(language, "actionWait");
  }

  if (signal === "NO_TRADE") {
    return t(language, "actionStandAside");
  }

  return formatSignalLabel(signal);
}

function getClarityLabel(language, value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return t(language, "clarityUnknown");
  }

  if (value < 0.35) {
    return t(language, "clarityLow");
  }

  if (value < 0.7) {
    return t(language, "clarityMedium");
  }

  return t(language, "clarityHigh");
}

function getPrimaryLevel(analysis) {
  return formatPrice(analysis.levels?.entry) || formatPrice(analysis.limitPrice);
}

function buildActionCopy(language, analysis) {
  const level = getPrimaryLevel(analysis);

  if (analysis.signal === "BUY") {
    return level
      ? t(language, "buyActionCopy", { price: level })
      : t(language, "buyActionNoPrice");
  }

  if (analysis.signal === "SELL") {
    return level
      ? t(language, "sellActionCopy", { price: level })
      : t(language, "sellActionNoPrice");
  }

  if (analysis.signal === "WAIT_FOR_CONFIRMATION") {
    return level
      ? t(language, "waitActionCopy", { price: level })
      : t(language, "waitActionNoPrice");
  }

  return t(language, "standAsideCopy");
}

function getSignalTone(signal) {
  if (signal === "BUY") {
    return "buy";
  }

  if (signal === "SELL") {
    return "sell";
  }

  if (signal === "WAIT_FOR_CONFIRMATION") {
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

  const tone = getSignalTone(analysis.signal);
  const levels = analysis.levels || {};
  const symbol = analysis.symbol || t(language, "unknown");
  const mode = getModeDisplay(language, analysis.mode);
  const intent = formatIntentLabel(language, profile?.intent);
  const action = getActionLabel(language, analysis.signal);
  const clarity = getClarityLabel(language, analysis.confidence);
  const positionSummary = profile?.positionContext
    ? t(language, "positionSummary", {
      shares: profile.positionContext.currentShares ?? 0,
      cost: profile.positionContext.averageCost ?? t(language, "noCostBasis")
    })
    : t(language, "noPositionContext");

  analysisCard.className = "analysis-card";
  analysisCard.innerHTML = `
    <section class="signal-banner ${tone}">
      <div class="signal-topline">
        <div>
          <p class="signal-label">${escapeHtml(t(language, "actionNow"))}</p>
          <h3 class="signal-value">${escapeHtml(action)}</h3>
        </div>
        <span class="pill">${escapeHtml(t(language, "modeLabel", { mode }))}</span>
      </div>
      <div class="guidance-grid">
        ${renderGuidanceCard(t(language, "whatToDoNow"), buildActionCopy(language, analysis))}
      </div>
      <div class="signal-meta">
        <span class="pill">${escapeHtml(t(language, "signalClarity"))} ${escapeHtml(clarity)}</span>
      </div>
    </section>
    <div class="analysis-grid">
      ${renderMetricCard(language, t(language, "symbol"), symbol)}
      ${renderMetricCard(language, t(language, "timeframe"), analysis.timeframe || t(language, "nA"))}
      ${renderMetricCard(language, t(language, "watchLevel"), levels.entry || analysis.limitPrice || t(language, "nA"))}
      ${renderMetricCard(language, t(language, "target"), levels.target || t(language, "nA"))}
      ${renderMetricCard(language, t(language, "riskTrigger"), levels.invalidation || t(language, "nA"))}
      ${renderMetricCard(language, t(language, "intent"), intent)}
      ${renderMetricCard(language, t(language, "position"), positionSummary, true)}
      ${renderMetricCard(language, t(language, "why"), analysis.summary || t(language, "nA"), true)}
      ${renderMetricCard(language, t(language, "riskNote"), analysis.riskNote || t(language, "nA"), true)}
    </div>
  `;
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
  modeSectionTitle.textContent = t(language, "chooseMode");
  modeSectionCopy.textContent = t(language, "chooseModeCopy");
  buyButton.textContent = t(language, "buy");
  sellButton.textContent = t(language, "sell");
  currentSharesLabel.textContent = t(language, "currentShares");
  averageCostLabel.textContent = t(language, "averageCost");
  intentLabel.textContent = t(language, "intent");
  backButton.textContent = t(language, "back");
  recommendationTitle.textContent = t(language, "latestRecommendation");
  apiKeyStatus.textContent = settings.openaiApiKey
    ? t(language, "apiKeySaved", { model: settings.model })
    : t(language, "noApiKeySaved");
}

function getSummary(state, language) {
  if (state.status === STATUS.VALIDATING) {
    return t(language, "validatingDetail");
  }

  if (state.status === STATUS.AWAITING_MODE) {
    return t(language, "chooseModeCopy");
  }

  if (state.status === STATUS.AWAITING_CONTEXT) {
    return state.mode === MODE.BUY ? t(language, "buySetupCopy") : t(language, "sellSetupCopy");
  }

  if (state.status === STATUS.RUNNING && state.isRoundInFlight) {
    return t(language, "analyzingCopy");
  }

  if (state.status === STATUS.RUNNING) {
    const intent = formatIntentLabel(language, state.monitoringProfile?.intent);
    return t(language, "monitoringDetail", {
      round: state.roundCount,
      maxRounds: state.maxRounds,
      mode: getModeDisplay(language, state.mode)
    }) + (state.monitoringProfile?.intent ? ` ${intent}.` : "");
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

function populateIntentOptions(mode, language, selectedIntent = null) {
  const options = INTENT_OPTIONS[mode] || [];
  intentSelect.innerHTML = options
    .map((option) => `<option value="${option.value}">${escapeHtml(t(language, `intent_${option.value}`))}</option>`)
    .join("");

  if (selectedIntent && options.some((option) => option.value === selectedIntent)) {
    intentSelect.value = selectedIntent;
  }
}

function updateFormGuidance(mode, language) {
  const selectedIntent = intentSelect.value;
  const requiresExistingPosition = mode === MODE.SELL || selectedIntent !== "new_position";

  currentSharesInput.required = true;
  currentSharesInput.min = requiresExistingPosition ? "0.0001" : "0";
  averageCostInput.required = requiresExistingPosition;

  if (mode === MODE.BUY && selectedIntent === "new_position") {
    formHint.textContent = t(language, "hintNewPosition");
    confirmButton.textContent = t(language, "startBuyMonitoring");
    return;
  }

  if (mode === MODE.BUY) {
    formHint.textContent = t(language, "hintAverageDown");
    confirmButton.textContent = t(language, "startBuyMonitoring");
    return;
  }

  formHint.textContent = t(language, "hintSell");
  confirmButton.textContent = t(language, "startSellMonitoring");
}

function populateContextForm(state, language) {
  const mode = state.mode;
  const profile = state.monitoringProfile;
  const selectedIntent = profile?.intent || (INTENT_OPTIONS[mode] || [])[0]?.value || "";
  const currentShares = profile?.positionContext?.currentShares;
  const averageCost = profile?.positionContext?.averageCost;

  contextTitle.textContent = mode === MODE.BUY ? t(language, "buySetup") : t(language, "sellSetup");
  contextDescription.textContent = mode === MODE.BUY
    ? t(language, "buySetupCopy")
    : t(language, "sellSetupCopy");

  populateIntentOptions(mode, language, selectedIntent);
  currentSharesInput.value = currentShares ?? "";
  averageCostInput.value = averageCost ?? "";
  updateFormGuidance(mode, language);
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

  modeSection.classList.toggle("hidden", state.status !== STATUS.AWAITING_MODE);
  contextSection.classList.toggle("hidden", state.status !== STATUS.AWAITING_CONTEXT);
  buyButton.disabled = state.status !== STATUS.AWAITING_MODE || !apiReady;
  sellButton.disabled = state.status !== STATUS.AWAITING_MODE || !apiReady;
  saveApiKeyButton.disabled = false;
  clearApiKeyButton.disabled = false;

  if (state.status === STATUS.AWAITING_CONTEXT && state.mode) {
    populateContextForm(state, language);
  }

  if ((state.status === STATUS.AWAITING_MODE || state.status === STATUS.AWAITING_CONTEXT) && !apiReady) {
    summaryText.textContent = t(language, "saveKeyFirst");
  }

  formError.textContent = "";
  formError.classList.add("hidden");
}

async function chooseMode(mode) {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  buyButton.disabled = true;
  sellButton.disabled = true;
  summaryText.textContent = t(language, "preparingSetup", { mode: getModeDisplay(language, mode) });

  await chrome.runtime.sendMessage({
    type: "choose-mode",
    mode
  });

  await render();
}

buyButton.addEventListener("click", async () => {
  await chooseMode(MODE.BUY);
});

sellButton.addEventListener("click", async () => {
  await chooseMode(MODE.SELL);
});

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

intentSelect.addEventListener("change", async () => {
  const state = await getState();
  const settings = await getSettings();
  const language = getLanguage(settings.language);

  if (state.status === STATUS.AWAITING_CONTEXT && state.mode) {
    updateFormGuidance(state.mode, language);
  }
});

backButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "back-to-mode-selection"
  });

  await render();
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

  if (!contextForm.reportValidity()) {
    return;
  }

  const state = await getState();
  const mode = state.mode;

  if (!mode) {
    return;
  }

  confirmButton.disabled = true;
  backButton.disabled = true;
  formError.textContent = "";
  formError.classList.add("hidden");
  summaryText.textContent = t(language, "startMonitoringProgress", { mode: getModeDisplay(language, mode) });
  isStartingMonitoring = true;
  renderAnalysisCard({
    ...state,
    status: STATUS.RUNNING
  }, language);

  let response;

  try {
    response = await chrome.runtime.sendMessage({
      type: "start-monitoring",
      mode,
      currentShares: currentSharesInput.value,
      averageCost: averageCostInput.value,
      intent: intentSelect.value
    });
  } finally {
    isStartingMonitoring = false;
  }

  if (!response?.ok) {
    formError.textContent = response?.error || t(language, "couldNotStart");
    formError.classList.remove("hidden");
    confirmButton.disabled = false;
    backButton.disabled = false;
    return;
  }

  await render();
});

chrome.storage.onChanged.addListener(async () => {
  await render();
});

void render();
