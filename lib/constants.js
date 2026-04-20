export const ALARM_NAME = "stock-chart-monitor";
export const MAX_RESULTS = 20;
// tradeHistory retains far fewer entries per day (~1 closed trade/day) than `results`
// (~72 rounds/day), so it needs a much larger cap — enough for months of journal history
// feeding the RECENT_LESSONS loop and upcoming stats card. Not unbounded, to prevent
// runaway growth over years of use.
export const MAX_TRADE_HISTORY = 500;
export const STORAGE_KEY = "monitorState";
export const DEFAULT_ANALYSIS_INTERVAL = 5;
export const DEFAULT_TOTAL_ROUNDS = 6;

export const STATUS = {
  IDLE: "idle",
  VALIDATING: "validating",
  AWAITING_CONTEXT: "awaiting_context",
  PAUSED: "paused",
  RUNNING: "running"
};

export const ANALYSIS_INTERVAL_OPTIONS = [
  { value: "5m", minutes: 5 },
  { value: "10m", minutes: 10 },
  { value: "15m", minutes: 15 },
  { value: "30m", minutes: 30 }
];

export const TOTAL_ROUNDS_OPTIONS = [
  { value: "6", rounds: 6 },
  { value: "12", rounds: 12 },
  { value: "24", rounds: 24 },
  { value: "48", rounds: 48 },
  { value: "96", rounds: 96 }
];

export function createDefaultState() {
  return {
    status: STATUS.IDLE,
    isRoundInFlight: false,
    roundStartedAt: null,
    monitoringProfile: null,
    lastMonitoringProfile: null,
    roundCount: 0,
    lastValidation: null,
    lastResult: null,
    results: [],
    virtualPosition: null,
    tradeHistory: [],
    stopReason: null,
    lastError: null,
    updatedAt: null
  };
}
