export const ALARM_NAME = "stock-chart-monitor";
export const ALARM_MINUTES = 5;
export const MAX_ROUNDS = 70;
export const MAX_RESULTS = 20;
export const STORAGE_KEY = "monitorState";

export const STATUS = {
  IDLE: "idle",
  VALIDATING: "validating",
  AWAITING_CONTEXT: "awaiting_context",
  PAUSED: "paused",
  RUNNING: "running"
};

export const RISK_STYLE_OPTIONS = [
  { value: "conservative" },
  { value: "moderate" },
  { value: "aggressive" }
];

export const AUTO_STOP_OPTIONS = [
  { value: "30m", minutes: 30 },
  { value: "1h", minutes: 60 },
  { value: "2h", minutes: 120 },
  { value: "4h", minutes: 240 },
  { value: "8h", minutes: 480 }
];

export function createDefaultState() {
  return {
    status: STATUS.IDLE,
    isRoundInFlight: false,
    monitoringProfile: null,
    lastMonitoringProfile: null,
    roundCount: 0,
    maxRounds: MAX_ROUNDS,
    lastValidation: null,
    lastResult: null,
    results: [],
    stopReason: null,
    lastError: null,
    updatedAt: null
  };
}
