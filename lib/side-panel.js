import { STATUS } from "./constants.js";
import { validateChartTab } from "./chart-validator.js";
import { getLanguage } from "./i18n.js";
import { getSettings, getState } from "./storage.js";

const SIDEPANEL_PATH = "sidepanel.html";
const SIDEPANEL_OTHER_TAB_PATH = "sidepanel-other-tab.html";

// Returns the side-panel config for a given tab — `{ enabled, path? }`.
//
// Chrome MV3 design constraint: there is **no API to close an already-open side
// panel** programmatically (no `chrome.sidePanel.close()`; the panel is a
// window-level UI). So we cannot make the panel disappear when the user
// switches to a non-bound tab. Instead, on non-bound tabs during a live
// session we swap the panel's content to a minimal "switch back" placeholder
// (`sidepanel-other-tab.html`). The panel column stays visible but its
// content makes the tab-binding obvious — and a one-click button jumps the
// user back to the monitored tab.
//
// State → config map:
// - RUNNING / PAUSED, tab === boundTabId  → enabled, full UI
// - RUNNING / PAUSED, other tab           → enabled, "other tab" placeholder
// - RUNNING / PAUSED, no boundTabId       → disabled (defensive: corrupted state)
// - AWAITING_CONTEXT, validated TV tab    → enabled, full UI
// - AWAITING_CONTEXT, anywhere else       → disabled
// - IDLE / VALIDATING                     → disabled everywhere
export function getSidePanelConfigForTab(state, tabId, validation) {
  if (state.status === STATUS.RUNNING || state.status === STATUS.PAUSED) {
    const boundTabId = state.monitoringProfile?.boundTabId
      ?? state.lastMonitoringProfile?.boundTabId
      ?? null;
    if (boundTabId === null) {
      return { enabled: false };
    }
    if (tabId === boundTabId) {
      return { enabled: true, path: SIDEPANEL_PATH };
    }
    return { enabled: true, path: SIDEPANEL_OTHER_TAB_PATH };
  }

  if (state.status === STATUS.AWAITING_CONTEXT) {
    if (validation.isTradingView && state.lastValidation?.tabId === tabId) {
      return { enabled: true, path: SIDEPANEL_PATH };
    }
    return { enabled: false };
  }

  return { enabled: false };
}

// Backwards-compatible thin wrapper used by call sites (and tests) that only
// care about the on/off state. New code should prefer `getSidePanelConfigForTab`
// since the path matters now too.
export function shouldEnableSidePanelForTab(state, tabId, validation) {
  return getSidePanelConfigForTab(state, tabId, validation).enabled;
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

  const config = getSidePanelConfigForTab(state, tabId, validation);

  if (config.enabled) {
    await chrome.sidePanel.setOptions({
      tabId,
      path: config.path,
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

// Re-evaluate side-panel config for every tab in the window. Used after Start /
// Continue / Restart so all current tabs immediately get the right path
// (full UI on bound tab, placeholder elsewhere) — not just on subsequent tab
// switches.
export async function enableSidePanelForWindow(windowId) {
  if (!windowId) {
    return;
  }

  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);

  await Promise.all(
    tabs.map((tab) => setSidePanelAvailabilityForTab(tab.id, tab).catch(() => {}))
  );
}

export { SIDEPANEL_PATH, SIDEPANEL_OTHER_TAB_PATH };
