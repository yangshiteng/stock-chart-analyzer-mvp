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
const popupDiscordSetupTitle = document.getElementById("popupDiscordSetupTitle");
const popupDiscordSetupCopy = document.getElementById("popupDiscordSetupCopy");
const popupDiscordWebhookLabel = document.getElementById("popupDiscordWebhookLabel");
const popupDiscordWebhookInput = document.getElementById("popupDiscordWebhookInput");
const popupSaveDiscordButton = document.getElementById("popupSaveDiscordButton");
const popupClearDiscordButton = document.getElementById("popupClearDiscordButton");
const popupDiscordStatus = document.getElementById("popupDiscordStatus");
const popupMarketHoursToggle = document.getElementById("popupMarketHoursToggle");
const popupMarketHoursLabel = document.getElementById("popupMarketHoursLabel");
const startButton = document.getElementById("startButton");
const statusText = document.getElementById("statusText");
const detailText = document.getElementById("detailText");
const chartSetupText = document.getElementById("chartSetupText");

function isValidDiscordWebhookUrl(value) {
  try {
    const url = new URL(value);
    const validHosts = new Set(["discord.com", "canary.discord.com", "ptb.discord.com", "discordapp.com"]);

    return url.protocol === "https:" && validHosts.has(url.hostname) && url.pathname.startsWith("/api/webhooks/");
  } catch {
    return false;
  }
}

function formatStatus(state, language) {
  if (state.status === STATUS.VALIDATING) {
    return {
      title: t(language, "validatingTitle"),
      detail: t(language, "validatingDetail")
    };
  }

  if (state.status === STATUS.AWAITING_CONTEXT) {
    return {
      title: t(language, "detectedTitle"),
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
      title: t(language, "monitoringTitle"),
      detail: t(language, "monitoringDetail", {
        round: state.roundCount
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
  popupDiscordSetupTitle.textContent = t(language, "discordSetup");
  popupDiscordSetupCopy.textContent = t(language, "discordSetupCopy");
  popupDiscordWebhookLabel.textContent = t(language, "discordWebhookUrl");
  popupSaveDiscordButton.textContent = t(language, "saveWebhook");
  popupClearDiscordButton.textContent = t(language, "clearWebhook");
  startButton.textContent = getStartButtonLabel(state, language);
  popupApiKeyInput.value = "";
  popupDiscordWebhookInput.value = "";
  popupApiKeyStatus.textContent = settings.openaiApiKey
    ? t(language, "apiKeySaved", { model: settings.model })
    : t(language, "noApiKeySaved");
  popupMarketHoursLabel.textContent = t(language, "marketHoursOnly");
  popupMarketHoursToggle.checked = Boolean(settings.marketHoursOnly);
  popupDiscordStatus.textContent = settings.discordWebhookUrl
    ? t(language, "discordWebhookSaved")
    : t(language, "noDiscordWebhookSaved");

  statusText.textContent = view.title;
  detailText.textContent = view.detail;
  chartSetupText.textContent = t(language, "chartSetupCopy");

  startButton.disabled = state.status === STATUS.VALIDATING || state.status === STATUS.RUNNING || state.status === STATUS.PAUSED;
  popupSaveKeyButton.disabled = false;
  popupClearKeyButton.disabled = false;
  popupSaveDiscordButton.disabled = false;
  popupClearDiscordButton.disabled = false;
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

startButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  startButton.disabled = true;
  statusText.textContent = t(language, "validatingTitle");

  const response = await chrome.runtime.sendMessage({
    type: "start-validation"
  });

  if (response?.ok && response.state?.status === STATUS.AWAITING_CONTEXT) {
    await openSidePanel();
    window.close();
    return;
  }

  await render();
});

popupMarketHoursToggle.addEventListener("change", async () => {
  await patchSettings({ marketHoursOnly: popupMarketHoursToggle.checked });
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

popupSaveDiscordButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const nextWebhook = popupDiscordWebhookInput.value.trim();

  if (!nextWebhook) {
    popupDiscordStatus.textContent = t(language, "enterWebhookFirst");
    return;
  }

  if (!isValidDiscordWebhookUrl(nextWebhook)) {
    popupDiscordStatus.textContent = t(language, "invalidDiscordWebhook");
    return;
  }

  popupSaveDiscordButton.disabled = true;
  popupClearDiscordButton.disabled = true;

  await patchSettings({
    discordWebhookUrl: nextWebhook
  });

  popupDiscordStatus.textContent = t(language, "discordWebhookReady");
  popupDiscordWebhookInput.value = "";
  await render();
});

popupClearDiscordButton.addEventListener("click", async () => {
  const settings = await getSettings();
  const language = getLanguage(settings.language);

  popupSaveDiscordButton.disabled = true;
  popupClearDiscordButton.disabled = true;

  await patchSettings({
    discordWebhookUrl: ""
  });

  popupDiscordStatus.textContent = t(language, "discordWebhookCleared");
  popupDiscordWebhookInput.value = "";
  await render();
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === "local" && (changes.monitorState || changes.appSettings)) {
    await render();
  }
});

void render();
