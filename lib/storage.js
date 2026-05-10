import { MAX_RESULTS, MAX_TRADE_HISTORY, STATE_VERSION, STORAGE_KEY, createDefaultState } from "./constants.js";
import { normalizeAnalysisIntervalRules } from "./analysis-intervals.js";
import { createDefaultMarketContext, normalizeMarketContext } from "./market-context.js";
import { normalizeSellStrategyRules } from "./sell-strategy.js";

const SETTINGS_KEY = "appSettings";

function createDefaultSettings() {
  return {
    openaiApiKey: "",
    discordWebhookUrl: "",
    model: "gpt-5.4",
    language: "en"
  };
}

function normalizeStoredProfile(profile) {
  if (!profile || typeof profile !== "object") {
    return null;
  }

  const { userContext, longTermContext, ...rest } = profile;
  void userContext;
  void longTermContext;
  const {
    analysisInterval,
    entryInterval,
    pendingInterval,
    positionInterval,
    quickProfitDelta,
    maxLossDelta,
    totalRounds,
    ...restRules
  } = rest.rules || {};
  void analysisInterval;
  void entryInterval;
  void pendingInterval;
  void positionInterval;
  void quickProfitDelta;
  void maxLossDelta;
  void totalRounds;
  return {
    ...rest,
    rules: {
      ...restRules,
      ...normalizeAnalysisIntervalRules(rest.rules),
      ...normalizeSellStrategyRules(rest.rules)
    }
  };
}

function normalizeArray(value, maxItems) {
  return Array.isArray(value) ? value.slice(0, maxItems) : [];
}

export function migrateState(storedState) {
  const base = createDefaultState();
  if (!storedState || typeof storedState !== "object") {
    return base;
  }

  const previousVersion = Number.isInteger(storedState.stateVersion) ? storedState.stateVersion : 0;
  const migrated = {
    ...base,
    ...storedState,
    results: normalizeArray(storedState.results, MAX_RESULTS),
    tradeHistory: normalizeArray(storedState.tradeHistory, MAX_TRADE_HISTORY),
    marketContext: normalizeMarketContext(storedState.marketContext),
    stateVersion: STATE_VERSION
  };

  migrated.monitoringProfile = normalizeStoredProfile(migrated.monitoringProfile);
  migrated.lastMonitoringProfile = normalizeStoredProfile(migrated.lastMonitoringProfile);
  delete migrated.longTermContextDraft;

  if (previousVersion < 3) {
    migrated.status = base.status;
    migrated.isRoundInFlight = false;
    migrated.roundStartedAt = null;
    migrated.monitoringProfile = null;
    migrated.roundCount = 0;
    migrated.lastValidation = null;
    migrated.lastResult = null;
    migrated.results = [];
    migrated.virtualPosition = null;
    migrated.pendingLimitOrder = null;
    migrated.stopReason = null;
    migrated.lastError = null;
  }

  if (previousVersion < 4) {
    migrated.lastSignalReview = null;
  }

  if (previousVersion < 5) {
    migrated.marketContext = createDefaultMarketContext();
  }

  if (previousVersion < 6) {
    migrated.premarketDipPlan = null;
  }

  if (previousVersion < 7) {
    migrated.monitoringProfile = normalizeStoredProfile(migrated.monitoringProfile);
    migrated.lastMonitoringProfile = normalizeStoredProfile(migrated.lastMonitoringProfile);
  }

  if (previousVersion < 8) {
    migrated.monitoringProfile = normalizeStoredProfile(migrated.monitoringProfile);
    migrated.lastMonitoringProfile = normalizeStoredProfile(migrated.lastMonitoringProfile);
  }

  if (previousVersion < 9) {
    migrated.monitoringProfile = normalizeStoredProfile(migrated.monitoringProfile);
    migrated.lastMonitoringProfile = normalizeStoredProfile(migrated.lastMonitoringProfile);
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
