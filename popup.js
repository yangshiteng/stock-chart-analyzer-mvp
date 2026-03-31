import { STATUS } from "./lib/constants.js";
import { getLanguage, t } from "./lib/i18n.js";
import { getSettings, getState, patchSettings } from "./lib/storage.js";

const popupEyebrow = document.getElementById("popupEyebrow");
const popupTitle = document.getElementById("popupTitle");
const popupLanguageLabel = document.getElementById("popupLanguageLabel");
const popupLanguageSelect = document.getElementById("popupLanguageSelect");
const popupLanguageEnglishOption = popupLanguageSelect.querySelector('option[value="en"]');
const popupLanguageChineseOption = popupLanguageSelect.querySelector('option[value="zh"]');
const popupApiSetupTitle = document.getElementById("popupApiSetupTitle");
const popupApiKeyLabel = document.getElementById("popupApiKeyLabel");
const popupApiKeyInput = document.getElementById("popupApiKeyInput");
const popupSaveKeyButton = document.getElementById("popupSaveKeyButton");
const popupClearKeyButton = document.getElementById("popupClearKeyButton");
const popupApiKeyStatus = document.getElementById("popupApiKeyStatus");
const startButton = document.getElementById("startButton");
const statusText = document.getElementById("statusText");
const detailText = document.getElementById("detailText");

function getModeDisplay(language, mode) {
  if (mode === "buy") {
    return t(language, "buy");
  }

  if (mode === "sell") {
    return t(language, "sell");
  }

  return mode ? `${mode}` : "";
}

function formatStatus(state, language) {
  if (state.status === STATUS.VALIDATING) {
    return {
      title: t(language, "validatingTitle"),
      detail: t(language, "validatingDetail")
    };
  }

  if (state.status === STATUS.AWAITING_MODE) {
    return {
      title: t(language, "detectedTitle"),
      detail: state.lastValidation?.reason || t(language, "validationPassed")
    };
  }

  if (state.status === STATUS.AWAITING_CONTEXT) {
    return {
      title: t(language, "fillSetupTitle", { mode: getModeDisplay(language, state.mode) }),
      detail: t(language, "fillSetupDetail")
    };
  }

  if (state.status === STATUS.PAUSED) {
    return {
      title: t(language, "pausedButton"),
      detail: state.stopReason || t(language, "clickStart")
    };
  }

  if (state.status === STATUS.RUNNING) {
    return {
      title: t(language, "monitoringTitle", { mode: getModeDisplay(language, state.mode) }),
      detail: t(language, "monitoringDetail", {
        round: state.roundCount,
        maxRounds: state.maxRounds,
        mode: getModeDisplay(language, state.mode)
      })
    };
  }

  return {
    title: t(language, "idle"),
    detail: state.lastError || state.stopReason || t(language, "clickStart")
  };
}

function getStartButtonLabel(state, language) {
  if (state.status === STATUS.RUNNING) {
    return t(language, "runningButton");
  }

  if (state.status === STATUS.PAUSED) {
    return t(language, "pausedButton");
  }

  if (state.status === STATUS.VALIDATING) {
    return t(language, "validatingButton");
  }

  return t(language, "start");
}

async function render() {
  const state = await getState();
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const view = formatStatus(state, language);

  popupEyebrow.textContent = t(language, "chromeExtensionMvp");
  popupTitle.textContent = t(language, "appTitle");
  popupLanguageLabel.textContent = t(language, "language");
  popupLanguageEnglishOption.textContent = t(language, "english");
  popupLanguageChineseOption.textContent = t(language, "chinese");
  popupLanguageSelect.value = language;
  popupApiSetupTitle.textContent = t(language, "openAiSetup");
  popupApiKeyLabel.textContent = t(language, "openAiApiKey");
  popupSaveKeyButton.textContent = t(language, "saveKey");
  popupClearKeyButton.textContent = t(language, "clearKey");
  startButton.textContent = getStartButtonLabel(state, language);
  popupApiKeyInput.value = "";
  popupApiKeyStatus.textContent = settings.openaiApiKey
    ? t(language, "apiKeySaved", { model: settings.model })
    : t(language, "noApiKeySaved");

  statusText.textContent = view.title;
  detailText.textContent = view.detail;

  startButton.disabled = state.status === STATUS.VALIDATING || state.status === STATUS.RUNNING || state.status === STATUS.PAUSED;
  popupSaveKeyButton.disabled = false;
  popupClearKeyButton.disabled = false;
}

async function openSidePanel() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (activeTab?.id) {
    await chrome.sidePanel.open({
      tabId: activeTab.id
    });
    return;
  }

  const currentWindow = await chrome.windows.getCurrent();

  await chrome.sidePanel.open({
    windowId: currentWindow.id
  });
}

function closePopup() {
  window.close();
}

startButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  startButton.disabled = true;
  statusText.textContent = t(language, "validatingTitle");

  const response = await chrome.runtime.sendMessage({
    type: "start-validation"
  });

  if (response?.ok && response.state?.status === STATUS.AWAITING_MODE) {
    await openSidePanel();
    closePopup();
    return;
  }

  await render();
});

popupLanguageSelect.addEventListener("change", async () => {
  await patchSettings({
    language: popupLanguageSelect.value
  });

  await render();
});

popupSaveKeyButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const nextKey = popupApiKeyInput.value.trim();

  if (!nextKey) {
    popupApiKeyStatus.textContent = t(language, "enterApiKeyFirst");
    return;
  }

  popupSaveKeyButton.disabled = true;
  popupClearKeyButton.disabled = true;

  await patchSettings({
    openaiApiKey: nextKey,
    model: "gpt-5.4"
  });

  popupApiKeyStatus.textContent = t(language, "apiKeyReady");
  popupApiKeyInput.value = "";
  await render();
});

popupClearKeyButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);

  popupSaveKeyButton.disabled = true;
  popupClearKeyButton.disabled = true;

  await patchSettings({
    openaiApiKey: "",
    model: "gpt-5.4"
  });

  popupApiKeyStatus.textContent = t(language, "apiKeyCleared");
  popupApiKeyInput.value = "";
  await render();
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === "local" && (changes.monitorState || changes.appSettings)) {
    await render();
  }
});

void render();
