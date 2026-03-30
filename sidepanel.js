import { INTENT_OPTIONS, MODE, STATUS } from "./lib/constants.js";
import { getSettings, getState, patchSettings } from "./lib/storage.js";

const statusBadge = document.getElementById("statusBadge");
const summaryText = document.getElementById("summaryText");
const apiSetupSection = document.getElementById("apiSetupSection");
const stopMonitorButton = document.getElementById("stopMonitorButton");
const continueMonitorButton = document.getElementById("continueMonitorButton");
const restartMonitorButton = document.getElementById("restartMonitorButton");
const apiKeyInput = document.getElementById("apiKeyInput");
const saveApiKeyButton = document.getElementById("saveApiKeyButton");
const clearApiKeyButton = document.getElementById("clearApiKeyButton");
const apiKeyStatus = document.getElementById("apiKeyStatus");
const modeSection = document.getElementById("modeSection");
const contextSection = document.getElementById("contextSection");
const buyButton = document.getElementById("buyButton");
const sellButton = document.getElementById("sellButton");
const contextTitle = document.getElementById("contextTitle");
const contextDescription = document.getElementById("contextDescription");
const contextForm = document.getElementById("contextForm");
const currentSharesInput = document.getElementById("currentSharesInput");
const averageCostInput = document.getElementById("averageCostInput");
const intentSelect = document.getElementById("intentSelect");
const formHint = document.getElementById("formHint");
const formError = document.getElementById("formError");
const confirmButton = document.getElementById("confirmButton");
const backButton = document.getElementById("backButton");
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

function formatIntentLabel(value) {
  return value ? value.replaceAll("_", " ") : "Not provided";
}

function formatSignalLabel(value) {
  return value ? value.replaceAll("_", " ") : "N/A";
}

function formatPrice(value) {
  return value && value !== "N/A" ? value : null;
}

function getActionLabel(signal) {
  if (signal === "BUY") {
    return "Buy";
  }

  if (signal === "SELL") {
    return "Sell";
  }

  if (signal === "WAIT_FOR_CONFIRMATION") {
    return "Wait";
  }

  if (signal === "NO_TRADE") {
    return "Stand Aside";
  }

  return formatSignalLabel(signal);
}

function getClarityLabel(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "Unknown";
  }

  if (value < 0.35) {
    return "Low";
  }

  if (value < 0.7) {
    return "Medium";
  }

  return "High";
}

function getPrimaryLevel(analysis) {
  return formatPrice(analysis.levels?.entry) || formatPrice(analysis.limitPrice);
}

function getPriceBadgeLabel(signal, limitPrice) {
  if (!limitPrice || limitPrice === "N/A") {
    return "No price level yet";
  }

  if (signal === "BUY") {
    return `Buy near ${limitPrice}`;
  }

  if (signal === "SELL") {
    return `Sell near ${limitPrice}`;
  }

  return `Watch ${limitPrice}`;
}

function buildActionCopy(analysis) {
  const level = getPrimaryLevel(analysis);

  if (analysis.signal === "BUY") {
    return level
      ? `Consider a limit buy near ${level} only if the chart continues to hold up.`
      : "A buy setup is forming, but wait for a clearer level before acting.";
  }

  if (analysis.signal === "SELL") {
    return level
      ? `Consider a limit sell near ${level} if weakness continues into that level.`
      : "A sell setup is forming, but wait for a cleaner exit level before acting.";
  }

  if (analysis.signal === "WAIT_FOR_CONFIRMATION") {
    return level
      ? `Do not enter yet. Wait for price to reclaim and hold near ${level} before acting.`
      : "Do not enter yet. Wait for stronger confirmation before taking a trade.";
  }

  return "Stand aside for now. There is no clean trade setup yet.";
}

function buildWatchCopy(analysis) {
  const watchLevel = getPrimaryLevel(analysis);
  const target = formatPrice(analysis.levels?.target);
  const invalidation = formatPrice(analysis.levels?.invalidation);

  const parts = [];

  if (watchLevel) {
    parts.push(`Watch ${watchLevel} for confirmation.`);
  }

  if (target) {
    parts.push(`If the move works, the next objective is ${target}.`);
  }

  if (invalidation) {
    parts.push(`If price fails below ${invalidation}, step back.`);
  }

  return parts.join(" ") || "Watch for cleaner structure before taking the next step.";
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

function renderMetricCard(label, value, fullSpan = false) {
  return `
    <article class="metric-card${fullSpan ? " full-span" : ""}">
      <p class="metric-label">${escapeHtml(label)}</p>
      <p class="metric-value">${escapeHtml(value || "N/A")}</p>
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

function renderAnalysisCard(state) {
  const result = state.lastResult;
  const analysis = result?.analysis;
  const profile = result?.monitoringProfile;

  if (isStartingMonitoring || (state.status === STATUS.RUNNING && state.roundCount === 0 && !analysis)) {
    analysisCard.className = "analysis-card";
    analysisCard.innerHTML = `
      <section class="loading-card">
        <div class="loading-spinner" aria-hidden="true"></div>
        <p class="loading-title">Analyzing chart...</p>
        <p class="loading-copy">The extension is capturing the current chart and requesting a recommendation. This can take a few seconds.</p>
      </section>
    `;
    return;
  }

  if (!analysis) {
    analysisCard.className = "analysis-card empty-analysis";
    analysisCard.innerHTML = '<p class="empty-state">Run a chart analysis to see the latest recommendation.</p>';
    return;
  }

  const tone = getSignalTone(analysis.signal);
  const levels = analysis.levels || {};
  const symbol = analysis.symbol || "Unknown";
  const mode = analysis.mode ? analysis.mode.toUpperCase() : "N/A";
  const intent = formatIntentLabel(profile?.intent);
  const action = getActionLabel(analysis.signal);
  const clarity = getClarityLabel(analysis.confidence);
  const primaryLevel = getPrimaryLevel(analysis);
  const positionSummary = profile?.positionContext
    ? `${profile.positionContext.currentShares ?? 0} shares at ${profile.positionContext.averageCost ?? "no cost basis"}`
    : "No position context";

  analysisCard.className = "analysis-card";
  analysisCard.innerHTML = `
    <section class="signal-banner ${tone}">
      <div class="signal-topline">
        <div>
          <p class="signal-label">Action now</p>
          <h3 class="signal-value">${escapeHtml(action)}</h3>
        </div>
        <span class="pill">${escapeHtml(mode)} mode</span>
      </div>
      <div class="guidance-grid">
        ${renderGuidanceCard("What to do now", buildActionCopy(analysis))}
        ${renderGuidanceCard("What to watch next", buildWatchCopy(analysis))}
      </div>
      <div class="signal-meta">
        <span class="pill">Signal Clarity ${escapeHtml(clarity)}</span>
        <span class="pill">${escapeHtml(getPriceBadgeLabel(analysis.signal, primaryLevel))}</span>
      </div>
    </section>
    <div class="analysis-grid">
      ${renderMetricCard("Symbol", symbol)}
      ${renderMetricCard("Timeframe", analysis.timeframe || "N/A")}
      ${renderMetricCard("Watch Level", levels.entry || analysis.limitPrice || "N/A")}
      ${renderMetricCard("Target", levels.target || "N/A")}
      ${renderMetricCard("Risk Trigger", levels.invalidation || "N/A")}
      ${renderMetricCard("Intent", intent)}
      ${renderMetricCard("Position", positionSummary, true)}
      ${renderMetricCard("Why", analysis.summary || "No summary returned.", true)}
      ${renderMetricCard("Risk note", analysis.riskNote || "N/A", true)}
    </div>
  `;
}

function getSummary(state) {
  if (state.status === STATUS.VALIDATING) {
    return "Capturing the active tab and running chart validation.";
  }

  if (state.status === STATUS.AWAITING_MODE) {
    return "Validation passed. Choose Buy or Sell to continue.";
  }

  if (state.status === STATUS.AWAITING_CONTEXT) {
    return `Fill in your ${state.mode?.toUpperCase()} setup, then start monitoring every 5 minutes.`;
  }

  if (state.status === STATUS.RUNNING) {
    const intent = state.monitoringProfile?.intent?.replaceAll("_", " ");
    return `Running in ${state.mode?.toUpperCase()} mode for ${intent || "the current setup"}. Completed ${state.roundCount} of ${state.maxRounds} rounds.`;
  }

  return state.lastError || state.stopReason || "Click Start in the popup to begin.";
}

function hasApiKey(settings) {
  return Boolean(settings.openaiApiKey);
}

function hasSavedMonitoringSession(state) {
  return Boolean(state.monitoringProfile || state.lastMonitoringProfile);
}

function populateIntentOptions(mode, selectedIntent = null) {
  const options = INTENT_OPTIONS[mode] || [];
  intentSelect.innerHTML = options
    .map((option) => `<option value="${option.value}">${option.label}</option>`)
    .join("");

  if (selectedIntent && options.some((option) => option.value === selectedIntent)) {
    intentSelect.value = selectedIntent;
  }
}

function updateFormGuidance(mode) {
  const selectedIntent = intentSelect.value;
  const requiresExistingPosition = mode === MODE.SELL || selectedIntent !== "new_position";

  currentSharesInput.required = true;
  currentSharesInput.min = requiresExistingPosition ? "0.0001" : "0";
  averageCostInput.required = requiresExistingPosition;

  if (mode === MODE.BUY && selectedIntent === "new_position") {
    formHint.textContent = "For a new position, current shares can be 0 and average cost can stay blank.";
    confirmButton.textContent = "Start Buy Monitoring";
    return;
  }

  if (mode === MODE.BUY) {
    formHint.textContent = "For add-to-position or average-down ideas, enter your current shares and average cost.";
    confirmButton.textContent = "Start Buy Monitoring";
    return;
  }

  formHint.textContent = "Sell monitoring expects an existing position, so shares and average cost are required.";
  confirmButton.textContent = "Start Sell Monitoring";
}

function populateContextForm(state) {
  const mode = state.mode;
  const profile = state.monitoringProfile;
  const selectedIntent = profile?.intent || (INTENT_OPTIONS[mode] || [])[0]?.value || "";
  const currentShares = profile?.positionContext?.currentShares;
  const averageCost = profile?.positionContext?.averageCost;

  contextTitle.textContent = mode === MODE.BUY ? "Buy Setup" : "Sell Setup";
  contextDescription.textContent = mode === MODE.BUY
    ? "Tell the analyzer whether you are opening, adding to, or averaging into a position."
    : "Tell the analyzer whether you are trying to take profit, cut loss, reduce, or fully exit.";

  populateIntentOptions(mode, selectedIntent);
  currentSharesInput.value = currentShares ?? "";
  averageCostInput.value = averageCost ?? "";
  updateFormGuidance(mode);
}

async function render() {
  const state = await getState();
  const settings = await getSettings();
  const apiReady = hasApiKey(settings);

  statusBadge.textContent = state.status === STATUS.IDLE ? "Idle" : state.status.replace("_", " ");
  summaryText.textContent = getSummary(state);
  apiKeyStatus.textContent = settings.openaiApiKey
    ? `API key saved locally. Model: ${settings.model}. Leave the field blank if you want to keep the current key.`
    : "No API key saved yet.";
  apiKeyInput.value = "";
  renderAnalysisCard(state);
  apiSetupSection.classList.toggle("hidden", apiReady);
  const hasSavedSession = hasSavedMonitoringSession(state);
  const isBusy = state.status === STATUS.RUNNING || state.status === STATUS.VALIDATING || isStartingMonitoring;

  stopMonitorButton.disabled = !isBusy;
  continueMonitorButton.disabled = !apiReady || state.status === STATUS.RUNNING || !hasSavedSession;
  restartMonitorButton.disabled = !apiReady || !hasSavedSession;

  modeSection.classList.toggle("hidden", state.status !== STATUS.AWAITING_MODE);
  contextSection.classList.toggle("hidden", state.status !== STATUS.AWAITING_CONTEXT);
  buyButton.disabled = state.status !== STATUS.AWAITING_MODE || !apiReady;
  sellButton.disabled = state.status !== STATUS.AWAITING_MODE || !apiReady;
  saveApiKeyButton.disabled = false;
  clearApiKeyButton.disabled = false;

  if (state.status === STATUS.AWAITING_CONTEXT && state.mode) {
    populateContextForm(state);
  }

  if ((state.status === STATUS.AWAITING_MODE || state.status === STATUS.AWAITING_CONTEXT) && !apiReady) {
    summaryText.textContent = "Save your OpenAI API key first, then continue with Buy or Sell.";
  }

  formError.textContent = "";
  formError.classList.add("hidden");
}

async function chooseMode(mode) {
  buyButton.disabled = true;
  sellButton.disabled = true;
  summaryText.textContent = `Preparing ${mode.toUpperCase()} setup...`;

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
  continueMonitorButton.disabled = true;
  restartMonitorButton.disabled = true;
  summaryText.textContent = "Continuing the previous monitoring session...";
  isStartingMonitoring = true;

  const state = await getState();
  renderAnalysisCard({
    ...state,
    status: STATUS.RUNNING
  });

  let response;

  try {
    response = await chrome.runtime.sendMessage({
      type: "continue-monitoring"
    });
  } finally {
    isStartingMonitoring = false;
  }

  if (!response?.ok) {
    summaryText.textContent = response?.error || "Could not continue monitoring.";
  }

  await render();
});

restartMonitorButton.addEventListener("click", async () => {
  continueMonitorButton.disabled = true;
  restartMonitorButton.disabled = true;
  summaryText.textContent = "Restarting monitoring from round 1...";
  isStartingMonitoring = true;

  const state = await getState();
  renderAnalysisCard({
    ...state,
    status: STATUS.RUNNING,
    roundCount: 0,
    lastResult: null
  });

  let response;

  try {
    response = await chrome.runtime.sendMessage({
      type: "restart-monitoring"
    });
  } finally {
    isStartingMonitoring = false;
  }

  if (!response?.ok) {
    summaryText.textContent = response?.error || "Could not restart monitoring.";
  }

  await render();
});

saveApiKeyButton.addEventListener("click", async () => {
  const nextKey = apiKeyInput.value.trim();

  if (!nextKey) {
    apiKeyStatus.textContent = "Enter an API key first, or click Clear Key.";
    return;
  }

  saveApiKeyButton.disabled = true;
  clearApiKeyButton.disabled = true;

  await patchSettings({
    openaiApiKey: nextKey,
    model: "gpt-5.4"
  });

  apiKeyStatus.textContent = "API key saved locally. gpt-5.4 is ready.";
  apiKeyInput.value = "";
  await render();
});

clearApiKeyButton.addEventListener("click", async () => {
  saveApiKeyButton.disabled = true;
  clearApiKeyButton.disabled = true;

  await patchSettings({
    openaiApiKey: "",
    model: "gpt-5.4"
  });

  apiKeyStatus.textContent = "API key cleared.";
  apiKeyInput.value = "";
  await render();
});

intentSelect.addEventListener("change", async () => {
  const state = await getState();

  if (state.status === STATUS.AWAITING_CONTEXT && state.mode) {
    updateFormGuidance(state.mode);
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

  if (!hasApiKey(settings)) {
    formError.textContent = "Save your OpenAI API key before starting monitoring.";
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
  summaryText.textContent = `Starting ${mode.toUpperCase()} monitoring...`;
  isStartingMonitoring = true;
  renderAnalysisCard({
    ...state,
    status: STATUS.RUNNING
  });

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
    formError.textContent = response?.error || "Could not start monitoring.";
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
