import { MAX_RESULTS, MAX_TRADE_HISTORY, STATE_VERSION, STORAGE_KEY, createDefaultState } from "./constants.js";

const SETTINGS_KEY = "appSettings";

function createDefaultSettings() {
  return {
    openaiApiKey: "",
    discordWebhookUrl: "",
    model: "gpt-5.4",
    language: "en",
    marketHoursOnly: false
  };
}

function stripRemovedProfileFields(profile) {
  if (!profile || typeof profile !== "object") {
    return null;
  }

  const { userContext, ...rest } = profile;
  void userContext;
  return rest;
}

function normalizeArray(value, maxItems) {
  return Array.isArray(value) ? value.slice(0, maxItems) : [];
}

export function migrateState(storedState) {
  const base = createDefaultState();
  if (!storedState || typeof storedState !== "object") {
    return base;
  }

  const previousVersion = Number.isInteger(storedState.stateVersion)
    ? storedState.stateVersion
    : 0;

  const migrated = {
    ...base,
    ...storedState,
    results: normalizeArray(storedState.results, MAX_RESULTS),
    tradeHistory: normalizeArray(storedState.tradeHistory, MAX_TRADE_HISTORY),
    stateVersion: STATE_VERSION
  };

  if (previousVersion < 1) {
    migrated.monitoringProfile = stripRemovedProfileFields(migrated.monitoringProfile);
    migrated.lastMonitoringProfile = stripRemovedProfileFields(migrated.lastMonitoringProfile);
  }

  return migrated;
}

export async function getState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);

  return migrateState(stored[STORAGE_KEY]);
}

export async function saveState(nextState) {
  const state = migrateState({
    ...nextState,
    updatedAt: new Date().toISOString()
  });

  await chrome.storage.local.set({ [STORAGE_KEY]: state });

  return state;
}

export async function patchState(partialState) {
  const currentState = await getState();

  return saveState({
    ...currentState,
    ...partialState
  });
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);

  return {
    ...createDefaultSettings(),
    ...(stored[SETTINGS_KEY] ?? {})
  };
}

export async function saveSettings(nextSettings) {
  const settings = {
    ...createDefaultSettings(),
    ...nextSettings
  };

  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });

  return settings;
}

export async function patchSettings(partialSettings) {
  const currentSettings = await getSettings();

  return saveSettings({
    ...currentSettings,
    ...partialSettings
  });
}
