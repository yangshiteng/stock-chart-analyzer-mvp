import { createDefaultMarketContext } from "./market-context.js";

export const ALARM_NAME = "stock-chart-monitor";
export const MAX_RESULTS = 20;
// tradeHistory retains far fewer entries per day (~1 closed trade/day) than `results`
// (~72 rounds/day), so it needs a much larger cap — enough for months of journal history
// feeding human review and the real-trade stats card. Not unbounded, to prevent
// runaway growth over years of use.
export const MAX_TRADE_HISTORY = 500;
export const STORAGE_KEY = "monitorState";
export const STATE_VERSION = 10;
export const DEFAULT_ANALYSIS_INTERVAL = 5;

export const STATUS = {
  IDLE: "idle",
  VALIDATING: "validating",
  AWAITING_CONTEXT: "awaiting_context",
  PAUSED: "paused",
  RUNNING: "running"
};

export const ANALYSIS_INTERVAL_OPTIONS = [
  { value: "1m", minutes: 1 },
  { value: "2m", minutes: 2 },
  { value: "5m", minutes: 5 },
  { value: "10m", minutes: 10 },
  { value: "15m", minutes: 15 },
  { value: "30m", minutes: 30 }
];

export function createDefaultState() {
  return {
    stateVersion: STATE_VERSION,
    status: STATUS.IDLE,
    isRoundInFlight: false,
    roundStartedAt: null,
    monitoringProfile: null,
    lastMonitoringProfile: null,
    roundCount: 0,
    lastValidation: null,
    lastResult: null,
    marketContext: createDefaultMarketContext(),
    premarketDipPlan: null,
    results: [],
    virtualPosition: null,
    pendingLimitOrder: null,
    tradeHistory: [],
    stopReason: null,
    lastError: null,
    updatedAt: null
  };
}
