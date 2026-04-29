import { STATUS } from "./constants.js";
import { validateChartTab } from "./chart-validator.js";
import { getLanguage } from "./i18n.js";
import { getSettings, getState } from "./storage.js";

const SIDEPANEL_PATH = "sidepanel.html";

export function shouldEnableSidePanelForTab(state, tabId, validation) {
  if (state.status === STATUS.RUNNING || state.status === STATUS.PAUSED) {
    // Side panel is bound to the original analysis tab. Switching to other tabs
    // hides the panel; switching back auto-shows it (Chrome's built-in per-tab
    // visibility behavior). Avoids the "ghost panel" effect when the user is
    // browsing news / docs / email on other tabs while a session is running.
    //
    // Note: supersedes the earlier "panel stays enabled on all tabs" choice
    // documented in CLAUDE.md Batch 1 #14. That older behavior was confusing
    // because the panel kept rendering recommendation cards while the user was
    // looking at unrelated tabs — implying the analysis still applied to
    // whatever tab was on top.
    const boundTabId = state.monitoringProfile?.boundTabId
      ?? state.lastMonitoringProfile?.boundTabId
      ?? null;
    return boundTabId !== null && tabId === boundTabId;
  }

  if (state.status === STATUS.AWAITING_CONTEXT) {
    return validation.isTradingView && state.lastValidation?.tabId === tabId;
  }

  return false;
}

// Re-evaluate side-panel availability for every tab in the window.
// Used after Start / Continue / Restart to install the bound-tab-only
// visibility rule across the whole window. The bound tab will end up with
// enabled=true; every other tab becomes enabled=false.
export async function enableSidePanelForWindow(windowId) {
  if (!windowId) {
    return;
  }

  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);

  await Promise.all(
    tabs.map((tab) => setSidePanelAvailabilityForTab(tab.id, tab).catch(() => {}))
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
