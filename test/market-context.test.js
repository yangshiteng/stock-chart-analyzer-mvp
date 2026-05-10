import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKET_CONTEXT_STATUS,
  createMarketContextForProfile,
  isMarketContextValidForProfile,
  mergeMarketContextScans,
  shouldPreserveMarketContextAcrossReset
} from "../lib/market-context.js";

const profile = { symbolOverride: "TSLA" };

test("market context: fresh context is tied to symbol and trading day", () => {
  const now = new Date("2026-05-05T14:00:00Z");
  const context = createMarketContextForProfile(profile, now);

  assert.equal(context.status, MARKET_CONTEXT_STATUS.MISSING);
  assert.equal(context.symbol, "TSLA");
  assert.equal(context.tradingDay, "2026-05-05");
});

test("market context: validity requires complete same-symbol same-day context", () => {
  const now = new Date("2026-05-05T14:00:00Z");
  const context = {
    status: MARKET_CONTEXT_STATUS.COMPLETE,
    symbol: "TSLA",
    tradingDay: "2026-05-05",
    dailyScan: { timeframe: "daily" },
    hourlyScan: { timeframe: "1h" },
    summary: {
      regime: "uptrend",
      aggression: "high",
      dipBuyPolicy: "aggressive",
      profitTakingStyle: "normal",
      keyLevels: [],
      riskNotes: ""
    }
  };

  assert.equal(isMarketContextValidForProfile(context, profile, now), true);
  assert.equal(isMarketContextValidForProfile({ ...context, symbol: "AAPL" }, profile, now), false);
  assert.equal(
    isMarketContextValidForProfile(context, profile, new Date("2026-05-06T14:00:00Z")),
    false
  );
});

test("market context: merge derives conservative policy when daily and 1H conflict", () => {
  const merged = mergeMarketContextScans({
    symbol: "TSLA",
    tradingDay: "2026-05-05",
    dailyScan: {
      timeframe: "daily",
      regime: "uptrend",
      keyLevels: [
        {
          label: "Daily shelf",
          type: "support",
          strength: "strong",
          timeframe: "daily",
          price: "180.50",
          zoneLow: null,
          zoneHigh: null,
          reason: "Held twice"
        }
      ],
      riskNotes: "Daily trend still rising."
    },
    hourlyScan: {
      timeframe: "1h",
      regime: "downtrend",
      keyLevels: [
        {
          label: "Nearby resistance",
          type: "resistance",
          strength: "medium",
          timeframe: "1h",
          price: "185.00",
          zoneLow: null,
          zoneHigh: null,
          reason: "Rejected twice"
        }
      ],
      riskNotes: "1H pullback is active."
    }
  });

  assert.equal(merged.status, MARKET_CONTEXT_STATUS.COMPLETE);
  assert.equal(merged.summary.regime, "range");
  assert.equal(merged.summary.aggression, "low");
  assert.equal(merged.summary.dipBuyPolicy, "support_only");
  assert.equal(merged.summary.profitTakingStyle, "quick_scalp");
  assert.equal(merged.summary.keyLevels.length, 2);
});

// ---- shouldPreserveMarketContextAcrossReset ----------------------------
//
// This decides whether `buildResetStatePreservingHistory` (background.js) keeps
// or wipes a previously-stored marketContext when state is reset (Exit button,
// chrome.runtime.onStartup cleanup, extension reload). Same-day + COMPLETE
// survives so the user does not have to re-scan after closing Chrome over
// lunch and reopening; cross-day or incomplete contexts are wiped.

const completeContext = {
  status: MARKET_CONTEXT_STATUS.COMPLETE,
  symbol: "TSLA",
  tradingDay: "2026-05-05",
  dailyScan: { regime: "uptrend" },
  hourlyScan: { regime: "uptrend" },
  summary: { regime: "uptrend", keyLevels: [] }
};

test("shouldPreserveMarketContextAcrossReset: keeps same-day COMPLETE context", () => {
  const now = new Date("2026-05-05T20:30:00Z");
  assert.equal(shouldPreserveMarketContextAcrossReset(completeContext, now), true);
});

test("shouldPreserveMarketContextAcrossReset: wipes context from a previous trading day", () => {
  // User scanned yesterday, closed Chrome overnight, reopened today. Yesterday's
  // structural context is no longer valid — must re-scan today's Daily / 1H.
  const now = new Date("2026-05-06T14:00:00Z");
  assert.equal(shouldPreserveMarketContextAcrossReset(completeContext, now), false);
});

test("shouldPreserveMarketContextAcrossReset: wipes incomplete context (only daily scanned)", () => {
  // Edge case: user scanned Daily but never finished 1H, then closed the
  // extension. status would be DAILY_SCANNED, not COMPLETE. Wipe it so the
  // next session starts the scan flow cleanly.
  const partial = {
    ...completeContext,
    status: MARKET_CONTEXT_STATUS.DAILY_SCANNED,
    hourlyScan: null
  };
  const now = new Date("2026-05-05T20:30:00Z");
  assert.equal(shouldPreserveMarketContextAcrossReset(partial, now), false);
});

test("shouldPreserveMarketContextAcrossReset: wipes null / missing context", () => {
  const now = new Date("2026-05-05T20:30:00Z");
  assert.equal(shouldPreserveMarketContextAcrossReset(null, now), false);
  assert.equal(shouldPreserveMarketContextAcrossReset(undefined, now), false);
  assert.equal(shouldPreserveMarketContextAcrossReset({}, now), false);
});

test("shouldPreserveMarketContextAcrossReset: ticker mismatch is NOT this function's concern", () => {
  // Symbol gating happens at consume-time via isMarketContextValidForProfile.
  // This helper only decides whether the data is fresh enough to keep around.
  // The next Start with a different ticker will fail the symbol check there
  // and force a re-scan automatically.
  const now = new Date("2026-05-05T20:30:00Z");
  assert.equal(shouldPreserveMarketContextAcrossReset(completeContext, now), true);
  // Even though completeContext.symbol === TSLA, this helper does not look at it.
});
