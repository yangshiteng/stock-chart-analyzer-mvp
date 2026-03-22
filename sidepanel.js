import { INTENT_OPTIONS, MODE, STATUS } from "./lib/constants.js";
import { getSettings, getState, patchSettings } from "./lib/storage.js";

const statusBadge = document.getElementById("statusBadge");
const summaryText = document.getElementById("summaryText");
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
const sessionJson = document.getElementById("sessionJson");
const validationJson = document.getElementById("validationJson");
const analysisJson = document.getElementById("analysisJson");
const historyList = document.getElementById("historyList");

function formatJson(data, fallback) {
  return data ? JSON.stringify(data, null, 2) : fallback;
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

function getProfileForDisplay(state) {
  return state.monitoringProfile || state.lastResult?.monitoringProfile || null;
}

function hasApiKey(settings) {
  return Boolean(settings.openaiApiKey);
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

function renderHistory(results) {
  if (!results.length) {
    historyList.innerHTML = '<p class="empty-state">No rounds yet.</p>';
    return;
  }

  historyList.innerHTML = results
    .map((result) => {
      const signal = result.analysis?.signal || "N/A";
      const confidence = result.analysis?.confidence ?? "N/A";

      return `
        <article class="history-item">
          <div class="history-row">
            <strong>Round ${result.round}</strong>
            <span>${result.mode.toUpperCase()}</span>
          </div>
          <div class="history-row muted-row">
            <span>${signal}</span>
            <span>${confidence}</span>
          </div>
          <p class="history-title">${result.pageTitle}</p>
        </article>
      `;
    })
    .join("");
}

async function render() {
  const state = await getState();
  const settings = await getSettings();
  const profileForDisplay = getProfileForDisplay(state);
  const apiReady = hasApiKey(settings);

  statusBadge.textContent = state.status === STATUS.IDLE ? "Idle" : state.status.replace("_", " ");
  summaryText.textContent = getSummary(state);
  apiKeyStatus.textContent = settings.openaiApiKey
    ? `API key saved locally. Model: ${settings.model}. Leave the field blank if you want to keep the current key.`
    : "No API key saved yet.";
  apiKeyInput.value = "";
  sessionJson.textContent = formatJson(profileForDisplay, "Choose a mode to define the session context.");
  validationJson.textContent = formatJson(state.lastValidation, "Waiting for validation...");
  analysisJson.textContent = formatJson(state.lastResult?.analysis, "Run a chart analysis to see results.");
  renderHistory(state.results);

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

  const response = await chrome.runtime.sendMessage({
    type: "start-monitoring",
    mode,
    currentShares: currentSharesInput.value,
    averageCost: averageCostInput.value,
    intent: intentSelect.value
  });

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
