export const ALARM_NAME = "stock-chart-monitor";
export const ALARM_MINUTES = 5;
export const MAX_ROUNDS = 70;
export const MAX_RESULTS = 20;
export const STORAGE_KEY = "monitorState";

export const STATUS = {
  IDLE: "idle",
  VALIDATING: "validating",
  AWAITING_MODE: "awaiting_mode",
  AWAITING_CONTEXT: "awaiting_context",
  PAUSED: "paused",
  RUNNING: "running"
};

export const MODE = {
  BUY: "buy",
  SELL: "sell"
};

export const INTENT_OPTIONS = {
  [MODE.BUY]: [
    { value: "new_position", label: "New Position" },
    { value: "add_to_position", label: "Add To Position" },
    { value: "average_down", label: "Average Down" }
  ],
  [MODE.SELL]: [
    { value: "take_profit", label: "Take Profit" },
    { value: "stop_loss", label: "Stop Loss" },
    { value: "reduce_position", label: "Reduce Position" },
    { value: "full_exit", label: "Full Exit" }
  ]
};

export function createDefaultState() {
  return {
    status: STATUS.IDLE,
    isRoundInFlight: false,
    mode: null,
    monitoringProfile: null,
    lastMode: null,
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
