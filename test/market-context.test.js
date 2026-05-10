import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKET_CONTEXT_STATUS,
  createMarketContextForProfile,
  isMarketContextValidForProfile,
  mergeMarketContextScans
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
