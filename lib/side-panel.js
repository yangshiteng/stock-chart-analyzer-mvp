import { STATUS } from "./constants.js";
import { validateChartTab } from "./chart-validator.js";
import { getLanguage } from "./i18n.js";
import { getSettings, getState } from "./storage.js";

const SIDEPANEL_PATH = "sidepanel.html";

export function shouldEnableSidePanelForTab(state, tabId, validation) {
  if (state.status === STATUS.RUNNING || state.status === STATUS.PAUSED) {
    return true;
  }

  if (state.status === STATUS.AWAITING_CONTEXT) {
    return validation.isTradingView && state.lastValidation?.tabId === tabId;
  }

  return false;
}

export async function enableSidePanelForWindow(windowId) {
  if (!windowId) {
    return;
  }

  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);

  await Promise.all(
    tabs.map((tab) =>
      chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: SIDEPANEL_PATH,
        enabled: true
      }).catch(() => {})
    )
  );
}

export async function setSidePanelAvailabilityForTab(tabId, tab = null) {
  if (!tabId) {
    return false;
  }

  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const state = await getState();
  const targetTab = tab || await chrome.tabs.get(tabId).catch(() => null);

  if (!targetTab) {
    return false;
  }

  const validation = validateChartTab({
    pageTitle: targetTab.title || "",
    pageUrl: targetTab.url || "",
    language
  });

  if (shouldEnableSidePanelForTab(state, tabId, validation)) {
    await chrome.sidePanel.setOptions({
      tabId,
      path: SIDEPANEL_PATH,
      enabled: true
    });

    return true;
  }

  await chrome.sidePanel.setOptions({
    tabId,
    enabled: false
  });

  return false;
}

export { SIDEPANEL_PATH };
