import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSidePanelConfigForTab,
  shouldEnableSidePanelForTab,
  SIDEPANEL_PATH,
  SIDEPANEL_OTHER_TAB_PATH
} from "../lib/side-panel.js";
import { STATUS } from "../lib/constants.js";

const BOUND_TAB_ID = 101;
const OTHER_TAB_ID = 202;

const tradingViewValidation = { isTradingView: true };
const nonTradingViewValidation = { isTradingView: false };

// ---- IDLE / VALIDATING ---------------------------------------------------

test("side-panel: IDLE state never enables the panel", () => {
  const state = { status: STATUS.IDLE };
  assert.deepEqual(
    getSidePanelConfigForTab(state, BOUND_TAB_ID, tradingViewValidation),
    { enabled: false }
  );
  assert.deepEqual(
    getSidePanelConfigForTab(state, OTHER_TAB_ID, tradingViewValidation),
    { enabled: false }
  );
});

test("side-panel: VALIDATING state never enables the panel", () => {
  const state = { status: STATUS.VALIDATING };
  assert.equal(getSidePanelConfigForTab(state, BOUND_TAB_ID, tradingViewValidation).enabled, false);
});

// ---- AWAITING_CONTEXT ----------------------------------------------------

test("side-panel: AWAITING_CONTEXT — full UI on validated TradingView tab", () => {
  const state = {
    status: STATUS.AWAITING_CONTEXT,
    lastValidation: { tabId: BOUND_TAB_ID }
  };
  assert.deepEqual(
    getSidePanelConfigForTab(state, BOUND_TAB_ID, tradingViewValidation),
    { enabled: true, path: SIDEPANEL_PATH }
  );
});

test("side-panel: AWAITING_CONTEXT rejects when tab is not TradingView", () => {
  const state = {
    status: STATUS.AWAITING_CONTEXT,
    lastValidation: { tabId: BOUND_TAB_ID }
  };
  assert.equal(
    getSidePanelConfigForTab(state, BOUND_TAB_ID, nonTradingViewValidation).enabled,
    false
  );
});

test("side-panel: AWAITING_CONTEXT rejects on a different tab even if it is TradingView", () => {
  const state = {
    status: STATUS.AWAITING_CONTEXT,
    lastValidation: { tabId: BOUND_TAB_ID }
  };
  assert.equal(
    getSidePanelConfigForTab(state, OTHER_TAB_ID, tradingViewValidation).enabled,
    false
  );
});

// ---- RUNNING / PAUSED — bound tab gets full UI; non-bound gets placeholder

test("side-panel: RUNNING — bound tab serves full sidepanel.html", () => {
  const state = {
    status: STATUS.RUNNING,
    monitoringProfile: { boundTabId: BOUND_TAB_ID }
  };
  assert.deepEqual(
    getSidePanelConfigForTab(state, BOUND_TAB_ID, tradingViewValidation),
    { enabled: true, path: SIDEPANEL_PATH }
  );
});

test("side-panel: RUNNING — non-bound tab serves the 'other tab' placeholder, NOT disabled", () => {
  // Chrome MV3 cannot close an open side panel; on non-bound tabs we keep the
  // panel enabled but swap its content. This is the core design pivot.
  const state = {
    status: STATUS.RUNNING,
    monitoringProfile: { boundTabId: BOUND_TAB_ID }
  };
  assert.deepEqual(
    getSidePanelConfigForTab(state, OTHER_TAB_ID, tradingViewValidation),
    { enabled: true, path: SIDEPANEL_OTHER_TAB_PATH }
  );
});

test("side-panel: RUNNING — bound-tab match does not require validation to pass", () => {
  // Even if the bound tab has somehow drifted off TradingView (e.g. user
  // navigated away mid-round), the side panel still belongs to that tab —
  // tab-activity logic elsewhere handles pausing the session. Side-panel
  // routing only cares about identity match.
  const state = {
    status: STATUS.RUNNING,
    monitoringProfile: { boundTabId: BOUND_TAB_ID }
  };
  assert.deepEqual(
    getSidePanelConfigForTab(state, BOUND_TAB_ID, nonTradingViewValidation),
    { enabled: true, path: SIDEPANEL_PATH }
  );
});

test("side-panel: PAUSED falls back to lastMonitoringProfile.boundTabId for routing", () => {
  // After Stop, monitoringProfile may be null while lastMonitoringProfile
  // preserves the binding so Continue can resume on the original tab.
  const state = {
    status: STATUS.PAUSED,
    monitoringProfile: null,
    lastMonitoringProfile: { boundTabId: BOUND_TAB_ID }
  };
  assert.deepEqual(
    getSidePanelConfigForTab(state, BOUND_TAB_ID, tradingViewValidation),
    { enabled: true, path: SIDEPANEL_PATH }
  );
  assert.deepEqual(
    getSidePanelConfigForTab(state, OTHER_TAB_ID, tradingViewValidation),
    { enabled: true, path: SIDEPANEL_OTHER_TAB_PATH }
  );
});

test("side-panel: RUNNING with no boundTabId disables panel everywhere (defensive)", () => {
  // Defensive: if the profile is corrupted (no boundTabId), disable panel on
  // all tabs rather than leaking the placeholder onto random tabs. Hidden bug
  // is more discoverable than a panel showing wrong context.
  const state = {
    status: STATUS.RUNNING,
    monitoringProfile: {},
    lastMonitoringProfile: {}
  };
  assert.equal(getSidePanelConfigForTab(state, BOUND_TAB_ID, tradingViewValidation).enabled, false);
  assert.equal(getSidePanelConfigForTab(state, OTHER_TAB_ID, tradingViewValidation).enabled, false);
});

test("side-panel: monitoringProfile.boundTabId takes precedence over lastMonitoringProfile", () => {
  const state = {
    status: STATUS.RUNNING,
    monitoringProfile: { boundTabId: BOUND_TAB_ID },
    lastMonitoringProfile: { boundTabId: OTHER_TAB_ID }
  };
  assert.deepEqual(
    getSidePanelConfigForTab(state, BOUND_TAB_ID, tradingViewValidation),
    { enabled: true, path: SIDEPANEL_PATH }
  );
  // OTHER_TAB_ID is the lastMonitoringProfile tab but live profile pointed at
  // BOUND_TAB_ID, so OTHER_TAB_ID should be treated as a non-bound tab.
  assert.deepEqual(
    getSidePanelConfigForTab(state, OTHER_TAB_ID, tradingViewValidation),
    { enabled: true, path: SIDEPANEL_OTHER_TAB_PATH }
  );
});

// ---- shouldEnableSidePanelForTab back-compat shim ------------------------

test("side-panel: shouldEnableSidePanelForTab agrees with getSidePanelConfigForTab.enabled", () => {
  const cases = [
    { state: { status: STATUS.IDLE }, tabId: BOUND_TAB_ID, expected: false },
    { state: { status: STATUS.RUNNING, monitoringProfile: { boundTabId: BOUND_TAB_ID } }, tabId: BOUND_TAB_ID, expected: true },
    // Non-bound tabs are now ENABLED (previously: disabled). The back-compat
    // shim must reflect the new "always enabled, content varies" semantics.
    { state: { status: STATUS.RUNNING, monitoringProfile: { boundTabId: BOUND_TAB_ID } }, tabId: OTHER_TAB_ID, expected: true }
  ];
  for (const { state, tabId, expected } of cases) {
    assert.equal(
      shouldEnableSidePanelForTab(state, tabId, tradingViewValidation),
      expected,
      `expected ${expected} for state ${state.status} tab ${tabId}`
    );
  }
});
