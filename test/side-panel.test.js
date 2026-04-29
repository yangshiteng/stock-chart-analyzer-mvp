import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldEnableSidePanelForTab } from "../lib/side-panel.js";
import { STATUS } from "../lib/constants.js";

const BOUND_TAB_ID = 101;
const OTHER_TAB_ID = 202;

const tradingViewValidation = { isTradingView: true };
const nonTradingViewValidation = { isTradingView: false };

// ---- IDLE / VALIDATING ---------------------------------------------------

test("side-panel: IDLE state never enables the panel", () => {
  const state = { status: STATUS.IDLE };
  assert.equal(shouldEnableSidePanelForTab(state, BOUND_TAB_ID, tradingViewValidation), false);
  assert.equal(shouldEnableSidePanelForTab(state, OTHER_TAB_ID, tradingViewValidation), false);
});

test("side-panel: VALIDATING state never enables the panel", () => {
  const state = { status: STATUS.VALIDATING };
  assert.equal(shouldEnableSidePanelForTab(state, BOUND_TAB_ID, tradingViewValidation), false);
});

// ---- AWAITING_CONTEXT ----------------------------------------------------

test("side-panel: AWAITING_CONTEXT enables only on the validated TradingView tab", () => {
  const state = {
    status: STATUS.AWAITING_CONTEXT,
    lastValidation: { tabId: BOUND_TAB_ID }
  };
  assert.equal(shouldEnableSidePanelForTab(state, BOUND_TAB_ID, tradingViewValidation), true);
});

test("side-panel: AWAITING_CONTEXT rejects when target tab is not TradingView", () => {
  const state = {
    status: STATUS.AWAITING_CONTEXT,
    lastValidation: { tabId: BOUND_TAB_ID }
  };
  assert.equal(shouldEnableSidePanelForTab(state, BOUND_TAB_ID, nonTradingViewValidation), false);
});

test("side-panel: AWAITING_CONTEXT rejects on a different tab even if it is TradingView", () => {
  const state = {
    status: STATUS.AWAITING_CONTEXT,
    lastValidation: { tabId: BOUND_TAB_ID }
  };
  assert.equal(shouldEnableSidePanelForTab(state, OTHER_TAB_ID, tradingViewValidation), false);
});

// ---- RUNNING / PAUSED — the bound-tab-only behavior ----------------------

test("side-panel: RUNNING enables only on the bound tab", () => {
  const state = {
    status: STATUS.RUNNING,
    monitoringProfile: { boundTabId: BOUND_TAB_ID }
  };
  assert.equal(shouldEnableSidePanelForTab(state, BOUND_TAB_ID, tradingViewValidation), true);
  assert.equal(shouldEnableSidePanelForTab(state, OTHER_TAB_ID, tradingViewValidation), false);
});

test("side-panel: RUNNING — bound-tab match does not require validation to pass", () => {
  // Even if the bound tab has somehow drifted off TradingView (e.g. user navigated
  // away mid-round), the side panel still belongs to that tab — `tabActivity`
  // logic elsewhere handles pausing the session. Side-panel visibility only
  // cares about identity match.
  const state = {
    status: STATUS.RUNNING,
    monitoringProfile: { boundTabId: BOUND_TAB_ID }
  };
  assert.equal(shouldEnableSidePanelForTab(state, BOUND_TAB_ID, nonTradingViewValidation), true);
});

test("side-panel: PAUSED falls back to lastMonitoringProfile.boundTabId", () => {
  // After Stop, monitoringProfile may be null while lastMonitoringProfile preserves
  // the binding so Continue can resume on the original tab.
  const state = {
    status: STATUS.PAUSED,
    monitoringProfile: null,
    lastMonitoringProfile: { boundTabId: BOUND_TAB_ID }
  };
  assert.equal(shouldEnableSidePanelForTab(state, BOUND_TAB_ID, tradingViewValidation), true);
  assert.equal(shouldEnableSidePanelForTab(state, OTHER_TAB_ID, tradingViewValidation), false);
});

test("side-panel: RUNNING with no boundTabId anywhere disables on every tab", () => {
  // Defensive: if the profile is somehow corrupted (no boundTabId), do not leak the
  // panel to arbitrary tabs. Prefer "hidden" over "shown on every tab" — a missing
  // panel is a discoverable bug; a panel showing wrong analysis is not.
  const state = {
    status: STATUS.RUNNING,
    monitoringProfile: {},
    lastMonitoringProfile: {}
  };
  assert.equal(shouldEnableSidePanelForTab(state, BOUND_TAB_ID, tradingViewValidation), false);
  assert.equal(shouldEnableSidePanelForTab(state, OTHER_TAB_ID, tradingViewValidation), false);
});

test("side-panel: monitoringProfile.boundTabId takes precedence over lastMonitoringProfile", () => {
  // Should only happen during transitional states, but guard the order anyway.
  const state = {
    status: STATUS.RUNNING,
    monitoringProfile: { boundTabId: BOUND_TAB_ID },
    lastMonitoringProfile: { boundTabId: OTHER_TAB_ID }
  };
  assert.equal(shouldEnableSidePanelForTab(state, BOUND_TAB_ID, tradingViewValidation), true);
  assert.equal(shouldEnableSidePanelForTab(state, OTHER_TAB_ID, tradingViewValidation), false);
});
