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
    dipBuyDiscount,
    totalRounds,
    ...restRules
  } = rest.rules || {};
  void analysisInterval;
  void entryInterval;
  void pendingInterval;
  void positionInterval;
  void quickProfitDelta;
  // maxLossDelta was the (removed) user-set stop-loss override that fired
  // SELL_NOW on a fixed dollar drop from entry, overriding the AI's
  // chart-based stopLossPrice. Destructured here so it's stripped from
  // stored profiles on read; v13 migration hook below re-normalizes for
  // explicit cleanup.
  void maxLossDelta;
  // dipBuyDiscount was a parameter for the (removed) buy-strategy feature.
  // Destructured here so it's stripped from stored profiles on read; the
  // v12 migration hook below also re-normalizes for explicit cleanup.
  void dipBuyDiscount;
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

  if (previousVersion < 5) {
    migrated.marketContext = createDefaultMarketContext();
  }

  // (v6 originally added `premarketDipPlan: null`. The field was removed
  // entirely in v14; the v14 hook below deletes it, so the v6 initialization
  // is no longer needed.)

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

  if (previousVersion < 10) {
    // Signal Review feature was removed: it was a per-trade challenge loop where
    // the user could text-challenge the AI's signal and the AI would re-analyze.
    // Removed because it invited confirmation bias at exactly the highest-emotion
    // moment (when the user disagreed with the signal). Drop any stored review
    // record so the new state shape is clean.
    delete migrated.lastSignalReview;
  }

  if (previousVersion < 11) {
    // dipBuyDiscount field added to monitoringProfile.rules. Pre-existing
    // profiles without it would get the default applied implicitly by
    // normalizeStoredProfile on the next normalization pass — but re-run it
    // explicitly here so the default lands on disk during the migration
    // round, not silently on first read.
    migrated.monitoringProfile = normalizeStoredProfile(migrated.monitoringProfile);
    migrated.lastMonitoringProfile = normalizeStoredProfile(migrated.lastMonitoringProfile);
  }

  if (previousVersion < 12) {
    // dipBuyDiscount feature was removed: it forced the AI's BUY_LIMIT price
    // to stay at least N below current price, which (1) over-constrained the
    // AI's entry judgment and (2) caused a chase-down race where a fresh
    // round's lower currentPrice would force the validator to demand an even
    // lower limit, so the previous resting order's price stopped matching
    // the model's actual signal. Re-normalize stored profiles so the field
    // is stripped from on-disk state; normalizeStoredProfile destructures
    // dipBuyDiscount out of rules and rebuilds without it.
    migrated.monitoringProfile = normalizeStoredProfile(migrated.monitoringProfile);
    migrated.lastMonitoringProfile = normalizeStoredProfile(migrated.lastMonitoringProfile);
  }

  if (previousVersion < 13) {
    // maxLossDelta feature was removed: same anti-pattern as the removed
    // dipBuyDiscount. The AI already returns a chart-based stopLossPrice
    // each round (structural invalidation: below EMA20 / swing low / VWAP).
    // The user-set maxLossDelta layered a fixed dollar-drop trigger on top,
    // forcing SELL_NOW before structure actually broke and chopping the
    // user out on noise. Hard caps belong at the broker (stop-loss order),
    // not in the plugin's prompt. Re-normalize profiles so the field is
    // stripped from on-disk state; quickProfitDelta is kept because
    // take-profit magnitude is genuinely a user style preference, not a
    // chart signal.
    migrated.monitoringProfile = normalizeStoredProfile(migrated.monitoringProfile);
    migrated.lastMonitoringProfile = normalizeStoredProfile(migrated.lastMonitoringProfile);
  }

  if (previousVersion < 14) {
    // premarketDipPlan feature was removed: it was an optional pre-open
    // BUY_LIMIT planner using a fixed 10% dip from yesterday's close,
    // available only 4:00-9:30 ET. Pulled because the plugin's mission
    // narrowed to "strict 5-minute intraday execution on TradingView" —
    // premarket dip-buying uses a different time domain (pre-regular
    // session), a different signal grammar (% discount from reference
    // price vs. chart-structure EMA/VWAP/Volume), and the user has other
    // channels for this kind of dip planning. Strip the dormant field
    // from on-disk state.
    delete migrated.premarketDipPlan;
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
