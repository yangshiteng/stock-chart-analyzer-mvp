// Side-panel content shown when the active tab is NOT the bound monitoring tab.
// Chrome MV3 cannot programmatically close an open side panel — the panel column
// stays visible across tab switches no matter what we do. So instead of trying to
// hide it, we render this minimal placeholder explaining that the analysis lives
// on a different tab, with a one-click button to jump back.
import { getSettings, getState } from "./lib/storage.js";
import { getLanguage, t } from "./lib/i18n.js";

const titleEl = document.getElementById("otherTabTitle");
const copyEl = document.getElementById("otherTabCopy");
const boundLabelEl = document.getElementById("otherTabBoundLabel");
const boundTitleEl = document.getElementById("otherTabBoundTitle");
const switchButton = document.getElementById("otherTabSwitchButton");
const errorEl = document.getElementById("otherTabSwitchError");

// Resolves the "where should the user switch to" target. During RUNNING/PAUSED
// it's the bound monitoring tab; during AWAITING_CONTEXT it's the tab that just
// passed validation (no profile yet). Returns null if neither is available.
function getTargetTab(state) {
  const profile = state.monitoringProfile || state.lastMonitoringProfile;
  if (profile?.boundTabId) {
    return {
      tabId: profile.boundTabId,
      windowId: profile.boundWindowId,
      title: profile.boundTabTitle || profile.symbolOverride || null
    };
  }
  const v = state.lastValidation;
  if (v?.tabId) {
    return {
      tabId: v.tabId,
      windowId: v.windowId,
      title: v.pageTitle || null
    };
  }
  return null;
}

async function render() {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const state = await getState();
  const target = getTargetTab(state);

  titleEl.textContent = t(language, "otherTabTitle");
  copyEl.textContent = t(language, "otherTabCopy");
  boundLabelEl.textContent = t(language, "otherTabBoundLabel");
  switchButton.textContent = t(language, "otherTabSwitchButton");

  boundTitleEl.textContent = target?.title || "(unknown)";
}

async function handleSwitchClick() {
  errorEl.classList.add("hidden");
  errorEl.textContent = "";

  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const state = await getState();
  const target = getTargetTab(state);

  if (!target?.tabId) {
    errorEl.textContent = t(language, "otherTabSwitchFailed");
    errorEl.classList.remove("hidden");
    return;
  }

  try {
    // Window focus first, then tab activate. Both required when target tab is
    // in a different window than the one currently in front.
    if (target.windowId) {
      await chrome.windows.update(target.windowId, { focused: true });
    }
    await chrome.tabs.update(target.tabId, { active: true });
  } catch {
    errorEl.textContent = t(language, "otherTabSwitchFailed");
    errorEl.classList.remove("hidden");
  }
}

switchButton.addEventListener("click", handleSwitchClick);

// Re-render on storage changes so the bound-tab label stays fresh if the user
// renames the tab (rare) or if language changes mid-session.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.monitorState || changes.appSettings) {
    render().catch(() => {});
  }
});

render().catch(() => {});
