import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RESULTS, MAX_TRADE_HISTORY, STATE_VERSION, STATUS } from "../lib/constants.js";
import { migrateState } from "../lib/storage.js";

test("migrateState: invalid input returns the current default state", () => {
  const state = migrateState(null);
  assert.equal(state.stateVersion, STATE_VERSION);
  assert.equal(state.status, STATUS.IDLE);
  assert.deepEqual(state.results, []);
  assert.deepEqual(state.tradeHistory, []);
});

test("migrateState: legacy state receives stateVersion and keeps known data", () => {
  const state = migrateState({
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
});

test("migrateState: v0 profiles drop removed userContext field", () => {
  const state = migrateState({
    monitoringProfile: {
      symbolOverride: "TSLA",
      userContext: "Earnings tomorrow.",
      rules: { analysisInterval: "5m", totalRounds: "6" }
    },
    lastMonitoringProfile: {
      symbolOverride: "AAPL",
      userContext: "Sector risk-off."
    }
  });

  assert.equal(state.monitoringProfile.symbolOverride, "TSLA");
  assert.equal(state.monitoringProfile.userContext, undefined);
  assert.equal(state.lastMonitoringProfile.symbolOverride, "AAPL");
  assert.equal(state.lastMonitoringProfile.userContext, undefined);
});

test("migrateState: malformed legacy profiles become null", () => {
  const state = migrateState({
    monitoringProfile: "not-an-object",
    lastMonitoringProfile: 42
  });

  assert.equal(state.monitoringProfile, null);
  assert.equal(state.lastMonitoringProfile, null);
});

test("migrateState: caps large arrays to storage limits", () => {
  const results = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => ({ id: `r${i}` }));
  const tradeHistory = Array.from({ length: MAX_TRADE_HISTORY + 5 }, (_, i) => ({ id: `t${i}` }));
  const state = migrateState({ results, tradeHistory });

  assert.equal(state.results.length, MAX_RESULTS);
  assert.equal(state.tradeHistory.length, MAX_TRADE_HISTORY);
  assert.equal(state.results.at(0).id, "r0");
  assert.equal(state.tradeHistory.at(0).id, "t0");
});
