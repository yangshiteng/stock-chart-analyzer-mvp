import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ACTIONS,
  ENTRY_MODE_ACTIONS,
  EXIT_MODE_ACTIONS,
  FORCE_EXIT_ACTIONS,
  buildAnalysisPromptFromConfig,
  buildMarketContextScanPrompt,
  getAllowedActions,
  validateAnalysisResult,
  validateMarketContextScanResult
} from "../lib/llm.js";
import { getAnalysisPromptConfig } from "../lib/prompt-config.js";

test("ALLOWED_ACTIONS: WAIT / HOLD / BUY_NOW removed (key-levels redesign)", () => {
  assert.deepEqual(
    [...ALLOWED_ACTIONS].sort(),
    ["BUY_LIMIT", "SELL_LIMIT", "SELL_NOW"]
  );
  assert.ok(!ALLOWED_ACTIONS.includes("BUY_NOW"), "BUY_NOW must not be reintroduced");
  assert.ok(!ALLOWED_ACTIONS.includes("WAIT"), "WAIT was removed; every round must emit a price");
  assert.ok(!ALLOWED_ACTIONS.includes("HOLD"), "HOLD was removed; exit emits SELL_LIMIT or SELL_NOW");
});

test("getAllowedActions: entry mode allows only BUY_LIMIT", () => {
  assert.deepEqual(getAllowedActions("entry"), ["BUY_LIMIT"]);
});

test("getAllowedActions: default is entry", () => {
  assert.deepEqual(getAllowedActions().sort(), [...ENTRY_MODE_ACTIONS].sort());
});

test("getAllowedActions: exit mode allows SELL_NOW + SELL_LIMIT only", () => {
  const actions = getAllowedActions("exit");
  assert.deepEqual(actions.sort(), ["SELL_LIMIT", "SELL_NOW"]);
  assert.deepEqual(actions.sort(), [...EXIT_MODE_ACTIONS].sort());
  assert.ok(!actions.includes("BUY_LIMIT"));
  assert.ok(!actions.includes("HOLD"));
  assert.ok(!actions.includes("WAIT"));
});

test("getAllowedActions: force_exit locks to SELL_NOW only", () => {
  assert.deepEqual(getAllowedActions("force_exit"), ["SELL_NOW"]);
  assert.deepEqual(FORCE_EXIT_ACTIONS, ["SELL_NOW"]);
});

const samplePayload = {
  pageTitle: "TSLA Stock Chart",
  pageUrl: "https://tradingview.com/chart?key=secret",
  symbolHint: "TSLA"
};

const sampleMarketContext = {
  regime: "uptrend",
  keyLevels: [
    {
      label: "Prior breakout shelf",
      type: "pivot",
      timeframe: "daily",
      price: "180.50",
      zoneLow: "180.00",
      zoneHigh: "181.00",
      reason: "Breakout retest held twice"
    }
  ],
  riskNotes: "Resistance overhead near 188."
};

test("buildAnalysisPromptFromConfig: entry mode injects ENTRY_MODE_RULES and SESSION_MODE", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), { ...samplePayload, mode: "entry" }, "en");
  assert.match(prompt, /\[SESSION_MODE\][\s\S]*ENTRY/);
  assert.match(prompt, /\[ENTRY_MODE_RULES\]/);
  assert.ok(!/\[EXIT_MODE_RULES\]/.test(prompt));
  assert.ok(!/\[FORCE_EXIT_RULES\]/.test(prompt));
});

test("buildAnalysisPromptFromConfig: exit mode includes virtual position context + EXIT_MODE_RULES", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "exit",
      virtualPosition: {
        entryPrice: "180.50",
        entryTime: "2026-04-20T13:30:00Z",
        stopLossPrice: "179.20",
        targetPrice: "183.00",
        reason: "breakout continuation",
        entryAnchorSource: "EMA20"
      }
    },
    "en"
  );
  assert.match(prompt, /\[SESSION_MODE\][\s\S]*EXIT/);
  assert.match(prompt, /\[POSITION_CONTEXT\]/);
  assert.match(prompt, /180\.50/);
  // sellStrategy was removed; quickProfitDelta no longer exists in any form.
  assert.ok(!/Quick-profit/i.test(prompt), "POSITION_CONTEXT must not inject quick-profit (removed)");
  assert.ok(!/Max-loss/i.test(prompt), "POSITION_CONTEXT must not inject a max-loss trigger");
  assert.match(prompt, /breakout continuation/);
  assert.match(prompt, /Entry anchor.*EMA20/i);
  assert.match(prompt, /\[EXIT_MODE_RULES\]/);
  // Allowed actions in CHART_CONTEXT enumeration should be SELL_NOW + SELL_LIMIT only.
  assert.match(prompt, /Allowed actions in this call: SELL_NOW, SELL_LIMIT\b/);
  assert.ok(!/Allowed actions in this call:[^\n]*HOLD/.test(prompt), "HOLD must not be in exit action vocabulary");
  assert.match(prompt, /strictly above currentPrice/);
  assert.ok(!/\[ENTRY_MODE_RULES\]/.test(prompt));
});

test("buildAnalysisPromptFromConfig: force_exit includes FORCE_EXIT_RULES", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "force_exit",
      virtualPosition: { entryPrice: "180.50" }
    },
    "en"
  );
  assert.match(prompt, /\[FORCE_EXIT_RULES\]/);
  assert.match(prompt, /FORCE_EXIT/);
});

test("buildAnalysisPromptFromConfig: required schema fields present in entry mode", () => {
  // Entry mode schema NO LONGER includes stop/target — those are set by the
  // first-exit analysis at fill time. See SELL_STRATEGY.md.
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  for (const key of ["orderPrice", "anchorSource"]) {
    assert.ok(prompt.includes(key), `entry prompt should mention ${key}`);
  }
  assert.ok(!/confidence/i.test(prompt), "confidence field must not be re-introduced into the prompt");
});

test("buildAnalysisPromptFromConfig: first_exit mode requires stopLossPrice + hardStopPrice in schema", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), {
    ...samplePayload,
    mode: "first_exit",
    virtualPosition: { entryPrice: "30.00", entryTime: "2026-05-14T14:00:00Z", entryAnchorSource: "EMA20" }
  }, "en");
  for (const key of ["stopLossPrice", "hardStopPrice", "anchorSource"]) {
    assert.ok(prompt.includes(key), `first_exit prompt should mention ${key}`);
  }
  assert.match(prompt, /\[FIRST_EXIT_MODE_RULES\]/);
});

test("buildAnalysisPromptFromConfig: no capital/position-size leakage", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.ok(!/availableCash/i.test(prompt));
  assert.ok(!/currentShares/i.test(prompt));
  assert.ok(!/riskStyle/i.test(prompt));
});

test("buildAnalysisPromptFromConfig: English LANGUAGE_OUTPUT section", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.match(prompt, /\[LANGUAGE_OUTPUT\]/);
  assert.match(prompt, /Return reasoning in English/);
  assert.ok(!/Simplified Chinese/.test(prompt));
});

test("buildAnalysisPromptFromConfig: Chinese LANGUAGE_OUTPUT section", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "zh");
  assert.match(prompt, /Simplified Chinese/);
});

test("buildAnalysisPromptFromConfig: Chinese mode keeps price fields raw and removes triggerCondition", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "zh");
  assert.match(prompt, /raw decimal prices/i);
});

test("buildAnalysisPromptFromConfig: English mode uses orderPrice as the actionable price", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.match(prompt, /orderPrice/);
});

test("buildAnalysisPromptFromConfig: legacy recentLessons are ignored", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      recentLessons: [
        {
          symbol: "AAPL",
          pnlPercent: -0.75,
          exitTime: "2026-04-18T20:00:00Z",
          lesson: "Legacy lesson should stay out of the prompt."
        }
      ]
    },
    "en"
  );

  assert.ok(!/\[RECENT_LESSONS\]/.test(prompt));
  assert.ok(!/Legacy lesson should stay out/.test(prompt));
});

test("buildAnalysisPromptFromConfig: LAST_SIGNAL_AND_ORDER injected in entry mode when lastSignal provided", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      lastSignal: {
        action: "BUY_LIMIT",
        orderPrice: "180.20",
        entryPrice: null,
        stopLossPrice: "179.10",
        targetPrice: "183.00",
        currentPrice: "181.30",
        anchorSource: "EMA20",
        reasoning: "BUY_LIMIT at EMA20"
      }
    },
    "en"
  );
  assert.match(prompt, /\[LAST_SIGNAL_AND_ORDER\]/);
  assert.match(prompt, /action=BUY_LIMIT/);
  assert.match(prompt, /orderPrice=180\.20/);
  assert.match(prompt, /anchor=EMA20/);
  assert.match(prompt, /Previous round's observed currentPrice: 181\.30/);
  // Three-way continuity rules (anchor unchanged value unchanged / anchor
  // unchanged value moved / anchor invalidated).
  assert.match(prompt, /ANCHOR UNCHANGED \+ VALUE UNCHANGED/);
  assert.match(prompt, /ANCHOR UNCHANGED \+ VALUE MOVED/);
  assert.match(prompt, /ANCHOR INVALIDATED/);
});

test("buildAnalysisPromptFromConfig: LAST_SIGNAL_AND_ORDER tolerates missing orderPrice / currentPrice", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      lastSignal: { action: "BUY_LIMIT", reasoning: "legacy round" }
    },
    "en"
  );
  assert.match(prompt, /orderPrice=null/);
  assert.match(prompt, /Previous round's observed currentPrice: \?/);
});

test("buildAnalysisPromptFromConfig: LAST_SIGNAL_AND_ORDER includes pending limit order details", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      pendingLimitOrder: {
        action: "BUY_LIMIT",
        limitPrice: "180.50",
        stopLossPrice: "179.10",
        targetPrice: "183.00",
        anchorSource: "EMA20",
        placedAt: new Date(Date.now() - 5 * 60000).toISOString()
      }
    },
    "en"
  );
  assert.match(prompt, /\[LAST_SIGNAL_AND_ORDER\]/);
  assert.match(prompt, /BUY_LIMIT order at \$180\.50/);
  assert.match(prompt, /still resting/);
  assert.match(prompt, /anchor source: EMA20/);
  // Three-way continuity rules are emitted for pending orders too
  assert.match(prompt, /ANCHOR UNCHANGED \+ VALUE UNCHANGED/);
  assert.match(prompt, /ANCHOR UNCHANGED \+ VALUE MOVED/);
  assert.match(prompt, /ANCHOR INVALIDATED/);
});

test("buildAnalysisPromptFromConfig: LAST_SIGNAL_AND_ORDER injected in exit mode", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "exit",
      virtualPosition: { entryPrice: "180.50" },
      lastSignal: { action: "SELL_LIMIT", orderPrice: "183.00", anchorSource: "prior_high", reasoning: "trend still up" }
    },
    "en"
  );
  assert.match(prompt, /\[LAST_SIGNAL_AND_ORDER\]/);
  assert.match(prompt, /action=SELL_LIMIT/);
});

test("buildAnalysisPromptFromConfig: LAST_SIGNAL_AND_ORDER omitted in force_exit mode", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "force_exit",
      virtualPosition: { entryPrice: "180.50" },
      lastSignal: { action: "SELL_LIMIT", reasoning: "x" },
      pendingLimitOrder: {
        action: "SELL_LIMIT",
        limitPrice: "183.00",
        placedAt: new Date().toISOString()
      }
    },
    "en"
  );
  assert.ok(!/\[LAST_SIGNAL_AND_ORDER\]/.test(prompt));
});

test("buildAnalysisPromptFromConfig: LAST_SIGNAL_AND_ORDER omitted when neither lastSignal nor pending provided", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    { ...samplePayload, mode: "entry" },
    "en"
  );
  assert.ok(!/\[LAST_SIGNAL_AND_ORDER\]/.test(prompt));
});

test("buildAnalysisPromptFromConfig: USER_CONTEXT section is never emitted", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      userContext: "Earnings tomorrow."
    },
    "en"
  );
  assert.ok(!/\[USER_CONTEXT\]/.test(prompt));
  assert.ok(!/USER BIAS/.test(prompt));
});

test("buildAnalysisPromptFromConfig: prompt mentions EMA / VWAP / volume as level candidates and informational context", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.match(prompt, /VWAP/);
  assert.match(prompt, /volume/i);
  // EMA 20/50/100/200 + VWAP are now LEGITIMATE dynamic key levels — not just
  // trend indicators. They can serve as the BUY_LIMIT / SELL_LIMIT anchor.
  assert.match(prompt, /EMA 20 ?\/ ?EMA 50 ?\/ ?EMA 100 ?\/ ?EMA 200/i);
  // No more volume / VWAP "gating" rules — those were confirmation-based.
  // The key-levels strategy doesn't wait for confirmation.
  assert.ok(!/Volume gating/i.test(prompt), "volume gating rule was removed");
  assert.ok(!/VWAP gating/i.test(prompt), "VWAP gating rule was removed");
});

test("buildAnalysisPromptFromConfig: sanitizes URL", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.ok(!prompt.includes("key=secret"));
  assert.match(prompt, /https:\/\/tradingview\.com\/chart/);
});

test("buildAnalysisPromptFromConfig: legacy longTermContext is ignored", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      longTermContext: {
        timeframe: "daily",
        summary: "Legacy long-term note that should not reach the execution prompt."
      }
    },
    "en"
  );

  assert.ok(!/\[LONG_TERM_CONTEXT\]/.test(prompt));
  assert.ok(!/Legacy long-term note/.test(prompt));
});

test("buildAnalysisPromptFromConfig: injects Market Context Scan summary when present", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      marketContext: sampleMarketContext
    },
    "en"
  );

  assert.match(prompt, /\[MARKET_CONTEXT\]/);
  assert.match(prompt, /Regime: uptrend/);
  // Role-is-dynamic note (key levels are not pre-labeled support/resistance).
  assert.match(prompt, /role is dynamic/i);
  assert.match(prompt, /Prior breakout shelf/);
  // Derived policy fields removed.
  assert.ok(!/Dip-buy policy/.test(prompt));
  assert.ok(!/Aggression/.test(prompt));
  assert.ok(!/Profit-taking style/.test(prompt));
});

test("buildMarketContextScanPrompt: Daily scan tells user to hide VWAP and high-low labels", () => {
  const prompt = buildMarketContextScanPrompt({ ...samplePayload, timeframe: "daily" }, "en");
  assert.match(prompt, /Expected timeframe: daily/);
  assert.match(prompt, /3-6 months/);
  assert.match(prompt, /temporarily hidden on Daily/i);
  assert.match(prompt, /Visible-range High \/ Low labels should be hidden/);
  assert.match(prompt, /Do not include action, orderPrice/);
});

test("buildMarketContextScanPrompt: 1H scan makes VWAP optional", () => {
  const prompt = buildMarketContextScanPrompt({ ...samplePayload, timeframe: "1h" }, "en");
  assert.match(prompt, /Expected timeframe: 1h/);
  assert.match(prompt, /5-20 trading days/);
  assert.match(prompt, /VWAP is optional on 1H/);
});

test("validateMarketContextScanResult: accepts a valid scan and rejects wrong timeframe", () => {
  const scan = {
    timeframe: "daily",
    regime: "range",
    keyLevels: [
      {
        label: "Range support",
        type: "pivot",
        timeframe: "daily",
        price: "180.50",
        zoneLow: "180.00",
        zoneHigh: "181.00",
        reason: "Repeated pivot"
      }
    ],
    riskNotes: "Choppy range."
  };

  assert.deepEqual(validateMarketContextScanResult(scan, "daily"), scan);
  assert.throws(
    () => validateMarketContextScanResult({ ...scan, timeframe: "1h" }, "daily"),
    /expected daily/
  );
});

test("validateMarketContextScanResult: rejects legacy support/resistance type values", () => {
  // Schema collapsed: only pivot / gap / prior_high / prior_low are valid types
  // because role is now dynamic and decided at execution time.
  for (const badType of ["support", "resistance"]) {
    assert.throws(
      () => validateMarketContextScanResult({
        timeframe: "daily",
        regime: "range",
        keyLevels: [{
          label: "L1", type: badType, timeframe: "daily",
          price: "100.00", zoneLow: null, zoneHigh: null, reason: ""
        }],
        riskNotes: ""
      }, "daily"),
      /invalid keyLevels\[0\]\.type/
    );
  }
});

const validEntryAnalysis = {
  action: "BUY_LIMIT",
  // BUY_LIMIT must be strictly BELOW currentPrice in the key-levels design.
  orderPrice: "180.20",
  entryPrice: null,
  stopLossPrice: "179.80",
  targetPrice: "182.00",
  reasoning: "BUY_LIMIT at EMA20 below current; price above all EMAs (strong)",
  symbol: "TSLA",
  currentPrice: "180.70",
  anchorSource: "EMA20"
};

test("validateAnalysisResult: accepts a valid entry-mode long setup", () => {
  assert.equal(validateAnalysisResult(validEntryAnalysis, "entry"), validEntryAnalysis);
});

test("validateAnalysisResult: rejects action outside the current mode vocabulary", () => {
  assert.throws(
    () => validateAnalysisResult({ ...validEntryAnalysis, action: "SELL_NOW" }, "entry"),
    /only allows BUY_LIMIT/
  );
});

test("validateAnalysisResult: rejects non-positive or non-decimal price fields", () => {
  assert.throws(
    () => validateAnalysisResult({ ...validEntryAnalysis, currentPrice: "N/A" }, "entry"),
    /invalid currentPrice/
  );
  assert.throws(
    () => validateAnalysisResult({ ...validEntryAnalysis, currentPrice: "$180.70" }, "entry"),
    /invalid currentPrice/
  );
  assert.throws(
    () => validateAnalysisResult({ ...validEntryAnalysis, currentPrice: "0" }, "entry"),
    /invalid currentPrice/
  );
});

test("validateAnalysisResult: rejects BUY_LIMIT orderPrice >= currentPrice (must be a support below)", () => {
  // Key-levels strategy: BUY_LIMIT must be pre-placed at a level BELOW current
  // price. "Marketable limit at current price" is forbidden by design.
  assert.throws(
    () => validateAnalysisResult({ ...validEntryAnalysis, orderPrice: "180.70" }, "entry"),
    /strictly below currentPrice/
  );
  assert.throws(
    () => validateAnalysisResult({ ...validEntryAnalysis, orderPrice: "181.00" }, "entry"),
    /strictly below currentPrice/
  );
});

test("validateAnalysisResult: entry mode no longer validates stop/target (set by first-exit)", () => {
  // Entry mode schema dropped stop/target — they're set by the first-exit
  // analysis at fill time. Any stop/target in the entry output is ignored.
  const noStop = { ...validEntryAnalysis };
  delete noStop.stopLossPrice;
  delete noStop.targetPrice;
  assert.equal(validateAnalysisResult(noStop, "entry"), noStop);
  // Even nonsense stop/target values shouldn't fail entry validation now —
  // they're not in the entry schema's required fields.
  const bogusStop = { ...validEntryAnalysis, stopLossPrice: "999.99", targetPrice: "0.01" };
  assert.equal(validateAnalysisResult(bogusStop, "entry"), bogusStop);
});

test("validateAnalysisResult: first_exit mode validates dual stops + initial SELL_LIMIT", () => {
  const firstExit = {
    action: "SELL_LIMIT",
    orderPrice: "31.00",         // SELL_LIMIT at resistance
    stopLossPrice: "28.50",      // soft (below entry)
    hardStopPrice: "27.20",      // hard, must be below soft
    targetPrice: "31.00",
    reasoning: "SELL_LIMIT at prior_high",
    symbol: "TSLA",
    currentPrice: "30.00",
    anchorSource: "prior_high"
  };
  // Fresh fill case: entryPrice ≈ currentPrice (just filled).
  const context = { entryPrice: 30.00 };
  assert.equal(validateAnalysisResult(firstExit, "first_exit", context), firstExit);

  // hardStop NOT below softStop → fail
  assert.throws(
    () => validateAnalysisResult({ ...firstExit, hardStopPrice: "28.50" }, "first_exit", context),
    /hardStopPrice.*must be strictly below stopLossPrice/
  );

  // softStop above entryPrice → fail (with entry-based validation)
  assert.throws(
    () => validateAnalysisResult({ ...firstExit, stopLossPrice: "30.50" }, "first_exit", context),
    /stopLossPrice.*must be strictly below entryPrice/
  );

  // SELL_LIMIT orderPrice not above currentPrice → fail
  assert.throws(
    () => validateAnalysisResult({ ...firstExit, orderPrice: "29.50" }, "first_exit", context),
    /must be strictly above currentPrice/
  );
});

test("validateAnalysisResult: first_exit stops anchor on entryPrice (manual position, current < entry)", () => {
  // Manual existing position: user bought at $25.15 (entry), current is $25.00.
  // Stops MUST be below entry $25.15, NOT below current $25.00. A softStop
  // of $25.05 would be invalid because it's ABOVE entry $25.15. Wait — that's
  // not right. Let me re-state: softStop must be < entry. So softStop $25.20
  // (above entry) would fail.
  const manualPosition = {
    action: "SELL_LIMIT",
    orderPrice: "25.04",         // SELL_LIMIT above current at EMA20
    stopLossPrice: "25.00",      // soft, below entry but at current price — OK
    hardStopPrice: "23.60",      // hard, below soft — OK
    targetPrice: "25.04",
    reasoning: "Recovery exit",
    symbol: "USAR",
    currentPrice: "25.00",
    anchorSource: "EMA20"
  };
  const context = { entryPrice: 25.15 };
  // softStop $25.00 < entry $25.15 → OK even though softStop == currentPrice
  // (the old rule would have FAILED this because softStop wasn't strictly below current).
  assert.equal(validateAnalysisResult(manualPosition, "first_exit", context), manualPosition);

  // softStop $25.20 > entry $25.15 → must fail
  assert.throws(
    () => validateAnalysisResult({ ...manualPosition, stopLossPrice: "25.20" }, "first_exit", context),
    /stopLossPrice.*must be strictly below entryPrice/
  );
});

test("validateAnalysisResult: first_exit falls back to currentPrice when entryPrice unavailable", () => {
  // Legacy / defensive path: if no entryPrice in context, validator falls
  // back to currentPrice for the stop sanity check (better than no check).
  const firstExit = {
    action: "SELL_LIMIT",
    orderPrice: "31.00",
    stopLossPrice: "28.50",
    hardStopPrice: "27.20",
    targetPrice: "31.00",
    reasoning: "fallback path",
    symbol: "TSLA",
    currentPrice: "30.00",
    anchorSource: "prior_high"
  };
  // No context passed at all.
  assert.equal(validateAnalysisResult(firstExit, "first_exit"), firstExit);
  // softStop $30.50 > currentPrice $30.00 → fails fallback check
  assert.throws(
    () => validateAnalysisResult({ ...firstExit, stopLossPrice: "30.50" }, "first_exit"),
    /stopLossPrice.*must be strictly below currentPrice/
  );
});

test("validateAnalysisResult: first_exit mode allows SELL_NOW for catastrophic gap-down", () => {
  const gapDown = {
    action: "SELL_NOW",
    orderPrice: null,
    stopLossPrice: "28.50",
    hardStopPrice: "27.20",
    targetPrice: null,
    reasoning: "Gap-down below any reasonable stop",
    symbol: "TSLA",
    currentPrice: "27.00",
    anchorSource: "stop_broken"
  };
  assert.equal(validateAnalysisResult(gapDown, "first_exit"), gapDown);
});

test("validateAnalysisResult: R:R 1:1 hard floor removed (key-levels redesign)", () => {
  // Previously a BUY_LIMIT with R:R < 1:1 was rejected. The new strategy
  // relies on aggregate edge across many small key-level attempts, not on
  // per-trade R:R, so the floor is gone. The user decides at the broker.
  const tightRR = {
    ...validEntryAnalysis,
    orderPrice: "180.50",
    stopLossPrice: "180.30",
    targetPrice: "180.80",
    currentPrice: "180.70"
  };
  // R:R from orderPrice perspective: reward 0.30 / risk 0.20 = 1.5:1 — OK
  // (chosen so all other validations still pass). Now flatten the target.
  const flatTarget = { ...tightRR, targetPrice: "180.71" }; // target above currentPrice but tiny
  // Should NOT throw any R:R-related error anymore.
  assert.equal(validateAnalysisResult(flatTarget, "entry"), flatTarget);
});

test("validateAnalysisResult: requires anchorSource on every output", () => {
  const noAnchor = { ...validEntryAnalysis };
  delete noAnchor.anchorSource;
  assert.throws(
    () => validateAnalysisResult(noAnchor, "entry"),
    /missing anchorSource/
  );
});

test("validateAnalysisResult: force_exit accepts only SELL_NOW with positive prices", () => {
  const forceExit = {
    ...validEntryAnalysis,
    action: "SELL_NOW",
    orderPrice: null,
    entryPrice: "180.50",
    stopLossPrice: "179.50",
    targetPrice: "180.10",
    currentPrice: "180.10",
    anchorSource: "force_exit"
  };

  assert.equal(validateAnalysisResult(forceExit, "force_exit"), forceExit);
  assert.throws(
    () => validateAnalysisResult({ ...forceExit, action: "SELL_LIMIT" }, "force_exit"),
    /only allows SELL_NOW/
  );
});

test("validateAnalysisResult: SELL_LIMIT requires an executable orderPrice", () => {
  const sellLimit = {
    ...validEntryAnalysis,
    action: "SELL_LIMIT",
    orderPrice: "182.00",
    entryPrice: "180.50",
    anchorSource: "prior_high"
  };

  assert.equal(validateAnalysisResult(sellLimit, "exit"), sellLimit);
  assert.throws(
    () => validateAnalysisResult({ ...sellLimit, orderPrice: null }, "exit"),
    /invalid orderPrice/
  );
});

test("validateAnalysisResult: exit SELL_NOW accepts immediate exits and rejects orderPrice", () => {
  const sellNow = {
    ...validEntryAnalysis,
    action: "SELL_NOW",
    orderPrice: null,
    entryPrice: "180.50",
    currentPrice: "180.70",
    anchorSource: "stop_broken"
  };

  assert.equal(validateAnalysisResult(sellNow, "exit"), sellNow);
  assert.throws(
    () => validateAnalysisResult({ ...sellNow, orderPrice: "180.70" }, "exit"),
    /orderPrice must be null/
  );
});

test("validateAnalysisResult: exit SELL_LIMIT must be above currentPrice", () => {
  const takeProfit = {
    ...validEntryAnalysis,
    action: "SELL_LIMIT",
    orderPrice: "181.25",
    entryPrice: "180.50",
    currentPrice: "180.70"
  };

  assert.equal(validateAnalysisResult(takeProfit, "exit"), takeProfit);
  assert.throws(
    () => validateAnalysisResult({ ...takeProfit, orderPrice: "180.70" }, "exit"),
    /above currentPrice/
  );
  assert.throws(
    () => validateAnalysisResult({ ...takeProfit, orderPrice: "180.25" }, "exit"),
    /above currentPrice/
  );
});

test("validateAnalysisResult: WAIT and HOLD are no longer valid actions", () => {
  // The key-levels redesign removed WAIT (entry) and HOLD (exit) entirely.
  // Every round emits a price-bearing action: BUY_LIMIT, SELL_LIMIT, or
  // SELL_NOW. Limit orders are zero-cost when they don't fill, so always
  // emitting a price is strictly safer than withholding one.
  const wait = { ...validEntryAnalysis, action: "WAIT", orderPrice: null };
  const hold = { ...validEntryAnalysis, action: "HOLD", orderPrice: null };
  assert.throws(
    () => validateAnalysisResult(wait, "entry"),
    /only allows BUY_LIMIT/
  );
  assert.throws(
    () => validateAnalysisResult(hold, "exit"),
    /only allows SELL_NOW, SELL_LIMIT/
  );
});
