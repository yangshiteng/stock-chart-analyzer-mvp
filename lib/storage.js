import { STORAGE_KEY, createDefaultState } from "./constants.js";

const SETTINGS_KEY = "appSettings";

function createDefaultSettings() {
  return {
    openaiApiKey: "",
    model: "gpt-5.4"
  };
}

export async function getState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);

  return {
    ...createDefaultState(),
    ...(stored[STORAGE_KEY] ?? {})
  };
}

export async function saveState(nextState) {
  const state = {
    ...createDefaultState(),
    ...nextState,
    updatedAt: new Date().toISOString()
  };

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
