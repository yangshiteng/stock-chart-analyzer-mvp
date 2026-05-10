import { ANALYSIS_INTERVAL_OPTIONS } from "./constants.js";
import { getUsMarketMinutesOfDay } from "./market-hours.js";

export const DEFAULT_ENTRY_INTERVAL = "5m";
export const DEFAULT_PENDING_INTERVAL = "2m";
export const DEFAULT_POSITION_INTERVAL = "1m";

const VALID_INTERVALS = new Set(ANALYSIS_INTERVAL_OPTIONS.map((option) => option.value));

export function isValidAnalysisInterval(value) {
  return VALID_INTERVALS.has(`${value || ""}`.trim());
}

export function normalizeAnalysisInterval(value, fallback = DEFAULT_ENTRY_INTERVAL) {
  const raw = `${value || ""}`.trim();
  return isValidAnalysisInterval(raw) ? raw : fallback;
}

export function normalizeAnalysisIntervalRules(rules = {}) {
  const legacy = normalizeAnalysisInterval(rules?.analysisInterval, DEFAULT_ENTRY_INTERVAL);
  return {
    entryInterval: normalizeAnalysisInterval(rules?.entryInterval, legacy),
    pendingInterval: normalizeAnalysisInterval(rules?.pendingInterval, DEFAULT_PENDING_INTERVAL),
    positionInterval: normalizeAnalysisInterval(rules?.positionInterval, DEFAULT_POSITION_INTERVAL)
  };
}

export function getAnalysisPhase(state = {}) {
  if (state.virtualPosition) {
    return "position";
  }
  if (state.pendingLimitOrder) {
    return "pending";
  }
  return "entry";
}

export function getActiveAnalysisIntervalRule(state = {}, rules = {}) {
  const normalizedRules = normalizeAnalysisIntervalRules(rules);
  const phase = getAnalysisPhase(state);
  if (phase === "position") {
    return normalizedRules.positionInterval;
  }
  if (phase === "pending") {
    return normalizedRules.pendingInterval;
  }
  return normalizedRules.entryInterval;
}

export function getIntervalRecommendationKey(now = new Date()) {
  const minutesOfDay = getUsMarketMinutesOfDay(now);
  if (minutesOfDay === null || minutesOfDay < 570 || minutesOfDay >= 960) {
    return "outside";
  }
  if (minutesOfDay < 630) {
    return "morning";
  }
  if (minutesOfDay < 930) {
    return "midday";
  }
  return "late";
}
