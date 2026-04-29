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

function getProfile(state) {
  return state.monitoringProfile || state.lastMonitoringProfile || null;
}

async function render() {
  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const state = await getState();
  const profile = getProfile(state);

  titleEl.textContent = t(language, "otherTabTitle");
  copyEl.textContent = t(language, "otherTabCopy");
  boundLabelEl.textContent = t(language, "otherTabBoundLabel");
  switchButton.textContent = t(language, "otherTabSwitchButton");

  // Show the bound tab title so the user knows which tab to look for. Falls back
  // to the symbol or "(unknown)" if title was not captured (older sessions).
  const boundLabel = profile?.boundTabTitle
    || profile?.symbolOverride
    || "(unknown)";
  boundTitleEl.textContent = boundLabel;
}

async function handleSwitchClick() {
  errorEl.classList.add("hidden");
  errorEl.textContent = "";

  const settings = await getSettings();
  const language = getLanguage(settings.language);
  const state = await getState();
  const profile = getProfile(state);

  if (!profile?.boundTabId) {
    errorEl.textContent = t(language, "otherTabSwitchFailed");
    errorEl.classList.remove("hidden");
    return;
  }

  try {
    // Window focus first, then tab activate. Both required when bound tab is
    // in a different window than the one currently in front.
    if (profile.boundWindowId) {
      await chrome.windows.update(profile.boundWindowId, { focused: true });
    }
    await chrome.tabs.update(profile.boundTabId, { active: true });
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
