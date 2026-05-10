import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RESULTS, MAX_TRADE_HISTORY, STATE_VERSION, STATUS } from "../lib/constants.js";
import { MARKET_CONTEXT_STATUS } from "../lib/market-context.js";
import { migrateState } from "../lib/storage.js";

test("migrateState: invalid input returns the current default state", () => {
  const state = migrateState(null);
  assert.equal(state.stateVersion, STATE_VERSION);
  assert.equal(state.status, STATUS.IDLE);
  assert.deepEqual(state.results, []);
  assert.deepEqual(state.tradeHistory, []);
  assert.equal(state.marketContext.status, MARKET_CONTEXT_STATUS.MISSING);
  assert.equal(state.premarketDipPlan, null);
});

test("migrateState: current-version state receives defaults and keeps known data", () => {
  const state = migrateState({
    stateVersion: STATE_VERSION,
    status: STATUS.RUNNING,
    roundCount: 3,
    tradeHistory: [{ id: "t1" }],
    results: [{ id: "r1" }]
  });

  assert.equal(state.stateVersion, STATE_VERSION);
  assert.equal(state.status, STATUS.RUNNING);
  assert.equal(state.roundCount, 3);
  assert.deepEqual(state.tradeHistory, [{ id: "t1" }]);
  assert.deepEqual(state.results, [{ id: "r1" }]);
  assert.equal(state.marketContext.status, MARKET_CONTEXT_STATUS.MISSING);
  assert.equal(state.premarketDipPlan, null);
});

test("migrateState: pre-v3 state clears old session signals but preserves journal and last profile", () => {
  const lastMonitoringProfile = {
    symbolOverride: "TSLA",
    longTermContext: { summary: "stale daily context" },
    rules: { analysisInterval: "5m", totalRounds: "6" }
  };
  const state = migrateState({
    stateVersion: 2,
    status: STATUS.RUNNING,
    isRoundInFlight: true,
    roundStartedAt: "2026-05-01T14:00:00Z",
    monitoringProfile: { symbolOverride: "AAPL" },
    lastMonitoringProfile,
    roundCount: 8,
    lastValidation: { ok: true },
    lastResult: { analysis: { action: "WAIT", triggerCondition: "old condition" } },
    results: [{ id: "r1" }],
    virtualPosition: { entryPrice: "180.50" },
    pendingLimitOrder: { action: "BUY_LIMIT", limitPrice: "180.50" },
    tradeHistory: [{ id: "t1" }],
    stopReason: "old stop",
    lastError: "old error"
  });

  assert.equal(state.stateVersion, STATE_VERSION);
  assert.equal(state.status, STATUS.IDLE);
  assert.equal(state.isRoundInFlight, false);
  assert.equal(state.roundStartedAt, null);
  assert.equal(state.monitoringProfile, null);
  assert.equal(state.roundCount, 0);
  assert.equal(state.lastValidation, null);
  assert.equal(state.lastResult, null);
  assert.deepEqual(state.results, []);
  assert.equal(state.virtualPosition, null);
  assert.equal(state.pendingLimitOrder, null);
  assert.deepEqual(state.tradeHistory, [{ id: "t1" }]);
  assert.equal(state.stopReason, null);
  assert.equal(state.lastError, null);
  assert.equal(state.lastMonitoringProfile.symbolOverride, "TSLA");
  assert.equal(state.lastMonitoringProfile.longTermContext, undefined);
  assert.deepEqual(state.lastMonitoringProfile.rules, {
    entryInterval: "5m",
    pendingInterval: "2m",
    positionInterval: "1m",
    quickProfitDelta: "0.20",
    maxLossDelta: "0.30"
  });
  assert.equal(state.marketContext.status, MARKET_CONTEXT_STATUS.MISSING);
});

test("migrateState: v3 state is upgraded to current version with marketContext cleared", () => {
  const state = migrateState({
    stateVersion: 3,
    status: STATUS.RUNNING,
    tradeHistory: [{ id: "t1" }],
    results: [{ id: "r1" }]
  });

  assert.equal(state.stateVersion, STATE_VERSION);
  assert.equal(state.marketContext.status, MARKET_CONTEXT_STATUS.MISSING);
  assert.deepEqual(state.tradeHistory, [{ id: "t1" }]);
  assert.deepEqual(state.results, [{ id: "r1" }]);
});

test("migrateState: v9 state is upgraded to v10 with lastSignalReview field stripped", () => {
  // Signal Review feature was removed at v10. Any stored review record from
  // earlier versions must be silently dropped from state so the new shape
  // doesn't carry orphan data.
  const state = migrateState({
    stateVersion: 9,
    status: STATUS.IDLE,
    lastSignalReview: {
      id: "review-legacy",
      review: { action: "BUY_LIMIT", orderPrice: "182.00" }
    },
    tradeHistory: [{ id: "t1" }],
    results: []
  });

  assert.equal(state.stateVersion, STATE_VERSION);
  assert.equal(state.lastSignalReview, undefined);
  assert.equal("lastSignalReview" in state, false);
});

test("migrateState: v4 state is upgraded to v5 with Market Context reset", () => {
  const state = migrateState({
    stateVersion: 4,
    status: STATUS.RUNNING,
    marketContext: {
      status: MARKET_CONTEXT_STATUS.COMPLETE,
      symbol: "TSLA",
      tradingDay: "2026-05-05",
      summary: {
        regime: "uptrend",
        aggression: "high",
        dipBuyPolicy: "aggressive",
        profitTakingStyle: "normal",
        keyLevels: [],
        riskNotes: "old context"
      },
      dailyScan: { timeframe: "daily" },
      hourlyScan: { timeframe: "1h" }
    }
  });

  assert.equal(state.stateVersion, STATE_VERSION);
  assert.equal(state.marketContext.status, MARKET_CONTEXT_STATUS.MISSING);
  assert.equal(state.marketContext.summary, null);
});

test("migrateState: v5 state is upgraded to current version with premarket dip draft cleared", () => {
  const state = migrateState({
    stateVersion: 5,
    status: STATUS.AWAITING_CONTEXT,
    premarketDipPlan: {
      action: "BUY_LIMIT",
      orderPrice: "24.70"
    }
  });

  assert.equal(state.stateVersion, STATE_VERSION);
  assert.equal(state.premarketDipPlan, null);
});

test("migrateState: v6 profiles split legacy analysisInterval into state-specific intervals", () => {
  const state = migrateState({
    stateVersion: 6,
    monitoringProfile: {
      symbolOverride: "TSLA",
      rules: { analysisInterval: "10m", totalRounds: "8" }
    },
    lastMonitoringProfile: {
      symbolOverride: "AAPL",
      rules: { entryInterval: "15m", pendingInterval: "bad", positionInterval: "30m" }
    }
  });

  assert.equal(state.stateVersion, STATE_VERSION);
  assert.deepEqual(state.monitoringProfile.rules, {
    entryInterval: "10m",
    pendingInterval: "2m",
    positionInterval: "1m",
    quickProfitDelta: "0.20",
    maxLossDelta: "0.30"
  });
  assert.deepEqual(state.lastMonitoringProfile.rules, {
    entryInterval: "15m",
    pendingInterval: "2m",
    positionInterval: "30m",
    quickProfitDelta: "0.20",
    maxLossDelta: "0.30"
  });
});

test("migrateState: v7 profiles receive default sell strategy deltas", () => {
  const state = migrateState({
    stateVersion: 7,
    monitoringProfile: {
      symbolOverride: "TSLA",
      rules: { entryInterval: "5m", quickProfitDelta: "0.25", maxLossDelta: "bad" }
    }
  });

  assert.equal(state.stateVersion, STATE_VERSION);
  assert.deepEqual(state.monitoringProfile.rules, {
    entryInterval: "5m",
    pendingInterval: "2m",
    positionInterval: "1m",
    quickProfitDelta: "0.25",
    maxLossDelta: "0.30"
  });
});

test("migrateState: v8 profiles drop removed total rounds rule", () => {
  const state = migrateState({
    stateVersion: 8,
    monitoringProfile: {
      symbolOverride: "TSLA",
      rules: {
        entryInterval: "1m",
        pendingInterval: "2m",
        positionInterval: "5m",
        quickProfitDelta: "0.20",
        maxLossDelta: "0.30",
        totalRounds: "96"
      }
    }
  });

  assert.equal(state.stateVersion, STATE_VERSION);
  assert.deepEqual(state.monitoringProfile.rules, {
    entryInterval: "1m",
    pendingInterval: "2m",
    positionInterval: "5m",
    quickProfitDelta: "0.20",
    maxLossDelta: "0.30"
  });
});

test("migrateState: profiles drop removed userContext and longTermContext fields", () => {
  const state = migrateState({
    stateVersion: STATE_VERSION,
    longTermContextDraft: { summary: "stale daily context" },
    monitoringProfile: {
      symbolOverride: "TSLA",
      userContext: "Earnings tomorrow.",
      longTermContext: { summary: "daily trend up" },
      rules: { analysisInterval: "5m", totalRounds: "6" }
    },
    lastMonitoringProfile: {
      symbolOverride: "AAPL",
      userContext: "Sector risk-off.",
      longTermContext: { summary: "weekly range" }
    }
  });

  assert.equal(state.longTermContextDraft, undefined);
  assert.equal(state.monitoringProfile.symbolOverride, "TSLA");
  assert.equal(state.monitoringProfile.userContext, undefined);
  assert.equal(state.monitoringProfile.longTermContext, undefined);
  assert.deepEqual(state.monitoringProfile.rules, {
    entryInterval: "5m",
    pendingInterval: "2m",
    positionInterval: "1m",
    quickProfitDelta: "0.20",
    maxLossDelta: "0.30"
  });
  assert.equal(state.lastMonitoringProfile.symbolOverride, "AAPL");
  assert.equal(state.lastMonitoringProfile.userContext, undefined);
  assert.equal(state.lastMonitoringProfile.longTermContext, undefined);
  assert.deepEqual(state.lastMonitoringProfile.rules, {
    entryInterval: "5m",
    pendingInterval: "2m",
    positionInterval: "1m",
    quickProfitDelta: "0.20",
    maxLossDelta: "0.30"
  });
});

test("migrateState: malformed current-version profiles become null", () => {
  const state = migrateState({
    stateVersion: STATE_VERSION,
    monitoringProfile: "not-an-object",
    lastMonitoringProfile: 42
  });

  assert.equal(state.monitoringProfile, null);
  assert.equal(state.lastMonitoringProfile, null);
});

test("migrateState: caps large arrays to storage limits", () => {
  const results = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => ({ id: `r${i}` }));
  const tradeHistory = Array.from({ length: MAX_TRADE_HISTORY + 5 }, (_, i) => ({ id: `t${i}` }));
  const state = migrateState({ stateVersion: STATE_VERSION, results, tradeHistory });

  assert.equal(state.results.length, MAX_RESULTS);
  assert.equal(state.tradeHistory.length, MAX_TRADE_HISTORY);
  assert.equal(state.results.at(0).id, "r0");
  assert.equal(state.tradeHistory.at(0).id, "t0");
});
