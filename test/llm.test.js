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

test("buildAnalysisPromptFromConfig: entry prompt pushes active intraday-structure scan (anti EMA-default bias)", () => {
  // Regression for the observed bias where AI defaults to the labeled EMA20
  // value as 'nearest support' and skips a clearer, nearer intraday
  // consolidation shelf / reaction low between current and EMA20. The fix
  // broadens the intraday level definition and adds active-scan instructions
  // so such intraday levels correctly enter the R1/R2 ranking.
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), {
    ...samplePayload,
    mode: "entry"
  }, "en");
  // Broadened intraday definition present (consolidation shelf / reaction low).
  assert.match(prompt, /consolidation shelf/i);
  assert.match(prompt, /reaction low/i);
  // Anti-default-to-EMA instruction present.
  assert.match(prompt, /do NOT skip straight to the labeled EMA\/VWAP|defaulting to EMA20 as the nearest support/i);
});

test("buildAnalysisPromptFromConfig: exit prompt also pushes active intraday-structure scan", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), {
    ...samplePayload,
    mode: "exit",
    virtualPosition: {
      entryPrice: "27.50",
      stopLossPrice: "27.00",
      hardStopPrice: "26.30",
      entryAnchorSource: "EMA20"
    }
  }, "en");
  assert.match(prompt, /INTRADAY STRUCTURE note/i);
  assert.match(prompt, /do NOT default to the labeled EMA\/VWAP/i);
});

test("buildAnalysisPromptFromConfig: first_exit prompt guards manual-holding bugs (above-current + no fixed_* in caution)", () => {
  // Regression for two real first_exit bugs hit when a user declares an
  // EXISTING position (manual_existing_position) that isn't a fresh fill:
  //
  // BUG 1 (caution zone, deterministic): prompt previously told AI to emit
  // "SELL_LIMIT @ fixed_soft_stop", but fixed_* is NOT in the first_exit
  // anchorSource enum (this analysis is WRITING the stop, can't reference a
  // stored value). AI following that instruction → guaranteed validator
  // rejection → position never recorded → "no reaction" on Start.
  //
  // BUG 2 (healthy zone w/ profit): prompt said "R1 = first level above
  // ENTRY". When current ran above entry, that level can be BELOW current,
  // and a SELL_LIMIT below current is invalid (would fill immediately). Must
  // pick the nearest level above CURRENT.
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), {
    ...samplePayload,
    mode: "first_exit",
    virtualPosition: { entryPrice: "27.50", entryTime: "2026-05-14T14:00:00Z", entryAnchorSource: "EMA20" }
  }, "en");

  // BUG 2 guard: the absolute "above currentPrice" rule must be present.
  assert.match(prompt, /strictly ABOVE currentPrice/);
  // BUG 1 guard: caution zone must explicitly forbid fixed_soft_stop and tell
  // AI to use the underlying level name.
  assert.match(prompt, /do NOT use 'fixed_soft_stop'/);
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
  // v19 reasoning forced format: must contain current=, candidates, mode=
  reasoning: "current=180.70; candidates=[R1=180.20@EMA20, R2=179.50@VWAP]; mode=conservative (default); chose=180.20@EMA20",
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
    reasoning: "zone=healthy; first-exit defaults to R1 (no post-entry bars); target=31.00@prior_high",
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
    reasoning: "zone=observation; manual position first-exit defaults to R1; target=25.04@EMA20",
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
    reasoning: "zone=healthy; fallback path (no entryPrice in context)",
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
    reasoning: "zone=hard-exit; gap-down below any reasonable stop",
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
    currentPrice: "180.70",
    // Reasoning must declare chose= matching orderPrice (cross-check)
    reasoning: "current=180.70; candidates=[R1=180.50@EMA20, R2=180.20@VWAP]; mode=conservative (default); chose=180.50@EMA20"
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
    anchorSource: "prior_high",
    // exit mode requires zone= marker, not entry's current=/candidates=/mode=
    reasoning: "zone=healthy; trend=normal; target=182.00@prior_high"
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
    anchorSource: "stop_broken",
    reasoning: "zone=hard-exit; hardStop broken; next deep support=178.00@EMA200"
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
    currentPrice: "180.70",
    reasoning: "zone=healthy; trend=normal; target=181.25@EMA20"
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

// ===== v19 anchorSource enum scope tests =====================================

test("validateAnalysisResult: v19 entry mode accepts intraday static anchors", () => {
  // v19 added intraday_high / intraday_low / opening_range_* / intraday_pivot
  // as legitimate anchorSource values for entry mode (formed during the
  // trading day, complement the static + dynamic anchors). For each anchor,
  // construct reasoning whose chose= matches the anchor (cross-check).
  for (const anchor of ["intraday_high", "intraday_low", "opening_range_high", "opening_range_low", "intraday_pivot"]) {
    const analysis = {
      ...validEntryAnalysis,
      anchorSource: anchor,
      reasoning: `current=180.70; candidates=[R1=180.20@${anchor}, R2=179.50@VWAP]; mode=conservative (default); chose=180.20@${anchor}`
    };
    assert.equal(validateAnalysisResult(analysis, "entry"), analysis);
  }
});

test("validateAnalysisResult: v19 entry mode rejects post-position anchors (fixed_*, aggressive_recovery)", () => {
  // fixed_soft_stop / fixed_hard_stop refer to virtualPosition.stopLossPrice /
  // hardStopPrice which don't exist in entry mode (user is flat, no position).
  // aggressive_recovery is a caution-zone exit-mode-only anchor.
  // Schema + validator both reject these in entry mode.
  for (const badAnchor of ["fixed_soft_stop", "fixed_hard_stop", "aggressive_recovery"]) {
    const analysis = { ...validEntryAnalysis, anchorSource: badAnchor };
    assert.throws(
      () => validateAnalysisResult(analysis, "entry"),
      /not allowed in entry mode/
    );
  }
});

test("validateAnalysisResult: v19 entry mode rejects SELL_NOW-only anchors (stop_broken, force_exit)", () => {
  // stop_broken and force_exit are SELL_NOW-only anchors. Entry mode only
  // allows BUY_LIMIT — these anchors can never appear there.
  for (const badAnchor of ["stop_broken", "force_exit"]) {
    const analysis = { ...validEntryAnalysis, anchorSource: badAnchor };
    assert.throws(
      () => validateAnalysisResult(analysis, "entry"),
      /not allowed in entry mode/
    );
  }
});

test("validateAnalysisResult: v19 first_exit mode rejects fixed_* and aggressive_recovery", () => {
  // first_exit is the analysis that WRITES virtualPosition.stopLossPrice /
  // hardStopPrice for the first time — it can't refer to them via fixed_*
  // because they don't exist yet. aggressive_recovery is also forbidden in
  // first_exit (forced conservative defaults per zone, no subjective upgrade).
  const baseFirstExit = {
    action: "SELL_LIMIT",
    orderPrice: "31.00",
    stopLossPrice: "28.50",
    hardStopPrice: "27.20",
    targetPrice: "31.00",
    reasoning: "zone=healthy; first-exit defaults to R1; target=31.00@prior_high",
    symbol: "TSLA",
    currentPrice: "30.00",
    anchorSource: "prior_high"
  };
  for (const badAnchor of ["fixed_soft_stop", "fixed_hard_stop", "aggressive_recovery"]) {
    assert.throws(
      () => validateAnalysisResult({ ...baseFirstExit, anchorSource: badAnchor }, "first_exit", { entryPrice: 30.00 }),
      /not allowed in first_exit mode/
    );
  }
});

test("validateAnalysisResult: v19 first_exit accepts intraday static + stop_broken (for gap-down)", () => {
  const baseFirstExit = {
    action: "SELL_LIMIT",
    orderPrice: "31.00",
    stopLossPrice: "28.50",
    hardStopPrice: "27.20",
    targetPrice: "31.00",
    reasoning: "zone=healthy; first-exit defaults to R1; target=31.00@intraday_high",
    symbol: "TSLA",
    currentPrice: "30.00",
    anchorSource: "intraday_high"
  };
  assert.equal(validateAnalysisResult(baseFirstExit, "first_exit", { entryPrice: 30.00 }), baseFirstExit);

  // stop_broken accepted in first_exit for gap-down SELL_NOW
  const gapDown = {
    action: "SELL_NOW",
    orderPrice: null,
    stopLossPrice: "28.50",
    hardStopPrice: "27.20",
    targetPrice: null,
    reasoning: "zone=hard-exit; gap-down below hardStop",
    symbol: "TSLA",
    currentPrice: "27.00",
    anchorSource: "stop_broken"
  };
  assert.equal(validateAnalysisResult(gapDown, "first_exit"), gapDown);
});

test("validateAnalysisResult: v19 exit mode accepts fixed_* and aggressive_recovery (in correct zone)", () => {
  // exit mode is the only mode where these anchors are valid.
  // fixed_soft_stop / fixed_hard_stop can appear in any exit zone where
  // they're geometrically valid candidates.
  const baseExit = {
    action: "SELL_LIMIT",
    orderPrice: "27.00",
    reasoning: "zone=caution; target=conservative=27.00@fixed_soft_stop (default)",
    symbol: "TSLA",
    currentPrice: "26.80",
    anchorSource: "fixed_soft_stop"
  };
  // Caution zone: hardStop=26.30 < current=26.80 ≤ softStop=27.00
  const cautionContext = { entryPrice: 27.50, softStop: 27.00, hardStop: 26.30 };
  assert.equal(validateAnalysisResult(baseExit, "exit", cautionContext), baseExit);

  // aggressive_recovery accepted in caution zone — but reasoning must satisfy
  // v19 evidence constraints (numbered list + no fuzzy words) since this is
  // an aggressive choice. Compliant reasoning provides 2 concrete evidence
  // items each with a number.
  const aggressive = {
    ...baseExit,
    orderPrice: "27.55",
    anchorSource: "aggressive_recovery",
    reasoning: "zone=caution; target=aggressive=27.55@aggressive_recovery (evidence: (1) reclaimed EMA20=26.92; (2) volume 1.8x of down bars)"
  };
  assert.equal(validateAnalysisResult(aggressive, "exit", cautionContext), aggressive);
});

test("validateAnalysisResult: v19 aggressive_recovery rejected when not in caution zone", () => {
  // aggressive_recovery is ONLY valid in caution zone (hardStop < current ≤ softStop).
  // In observation zone (current > softStop) or hard-exit zone (current ≤ hardStop)
  // it's a semantic error.
  const aggressive = {
    action: "SELL_LIMIT",
    orderPrice: "27.55",
    reasoning: "zone=observation; target=aggressive=27.55@aggressive_recovery (evidence: (1) test only; (2) test only)",
    symbol: "TSLA",
    currentPrice: "27.20",  // ABOVE softStop=27.00 — observation zone
    anchorSource: "aggressive_recovery"
  };
  const observationContext = { entryPrice: 27.50, softStop: 27.00, hardStop: 26.30 };
  assert.throws(
    () => validateAnalysisResult(aggressive, "exit", observationContext),
    /aggressive_recovery.*ABOVE softStop/
  );

  // Below hardStop = hard-exit zone, also rejected (must be SELL_NOW there)
  const aggressiveBelowHard = {
    ...aggressive,
    currentPrice: "26.20"  // BELOW hardStop=26.30
  };
  assert.throws(
    () => validateAnalysisResult(aggressiveBelowHard, "exit", observationContext),
    /aggressive_recovery.*AT OR BELOW hardStop/
  );
});

test("validateAnalysisResult: v19 aggressive_recovery zone check is skipped when stops missing (defensive)", () => {
  // If validationContext doesn't include softStop/hardStop (legacy callers,
  // null virtualPosition), the zone check defensively skips rather than
  // throwing. Better to allow a possibly-wrong anchor than to fail the round
  // when context is incomplete.
  const aggressive = {
    action: "SELL_LIMIT",
    orderPrice: "27.55",
    reasoning: "zone=caution; target=aggressive=27.55@aggressive_recovery (evidence: (1) defensive case; (2) defensive case)",
    symbol: "TSLA",
    currentPrice: "27.20",
    anchorSource: "aggressive_recovery"
  };
  // No softStop/hardStop in context → defensive skip
  assert.equal(validateAnalysisResult(aggressive, "exit"), aggressive);
});

test("validateAnalysisResult: v19 force_exit rejects any anchor except force_exit", () => {
  // force_exit mode locks anchorSource to "force_exit" only.
  const baseForce = {
    action: "SELL_NOW",
    orderPrice: null,
    reasoning: "close window",
    symbol: "TSLA",
    currentPrice: "180.50",
    anchorSource: "force_exit"
  };
  assert.equal(validateAnalysisResult(baseForce, "force_exit"), baseForce);

  // Any other anchor — even valid in other modes — rejected in force_exit
  for (const badAnchor of ["EMA20", "prior_high", "stop_broken", "fixed_soft_stop"]) {
    assert.throws(
      () => validateAnalysisResult({ ...baseForce, anchorSource: badAnchor }, "force_exit"),
      /not allowed in force_exit mode/
    );
  }
});

test("validateAnalysisResult: v19 invalid anchor values (typos, hallucinations) rejected in all modes", () => {
  // Catches AI hallucinations like "support" / "resistance" / "rsi_oversold".
  for (const badAnchor of ["support", "resistance", "rsi_oversold", "bullish_engulfing", ""]) {
    const analysis = { ...validEntryAnalysis, anchorSource: badAnchor };
    assert.throws(
      () => validateAnalysisResult(analysis, "entry"),
      // empty string fails the "missing anchorSource" check; non-empty bad
      // values fail the enum scope check
      /(missing anchorSource|not allowed in entry mode)/
    );
  }
});

// ===== v19 Stage 4b: reasoning format / aggressive evidence / cross-check =====
//
// These validators enforce the strategy docs' "reasoning forced format" +
// "aggressive choice requires ≥2 numeric evidence + no fuzzy words" +
// "anchor cross-check between reasoning and field" rules. See
// SELL_STRATEGY.md observation/caution zone CONSTRAINT sections and the
// BUY_STRATEGY.md R1/R2 subjective judgment section for full rationale.

test("validateAnalysisResult: v19 entry reasoning missing required markers (current=/candidates/mode=) rejected", () => {
  // Each required entry-mode marker missing → fail with clear error.
  const missingCurrent = {
    ...validEntryAnalysis,
    reasoning: "candidates=[R1=180.20@EMA20]; mode=conservative; chose=180.20@EMA20"
  };
  assert.throws(
    () => validateAnalysisResult(missingCurrent, "entry"),
    /missing required v19 marker.*current=/
  );

  const missingCandidates = {
    ...validEntryAnalysis,
    reasoning: "current=180.70; mode=conservative; chose=180.20@EMA20"
  };
  assert.throws(
    () => validateAnalysisResult(missingCandidates, "entry"),
    /missing required v19 marker.*candidates/
  );

  const missingMode = {
    ...validEntryAnalysis,
    reasoning: "current=180.70; candidates=[R1=180.20@EMA20]; chose=180.20@EMA20"
  };
  assert.throws(
    () => validateAnalysisResult(missingMode, "entry"),
    /missing required v19 marker.*mode=/
  );
});

test("validateAnalysisResult: v19 exit/first_exit reasoning missing 'zone=' marker rejected", () => {
  const missingZoneExit = {
    action: "SELL_LIMIT",
    orderPrice: "181.25",
    currentPrice: "180.70",
    symbol: "TSLA",
    anchorSource: "prior_high",
    reasoning: "trend=normal; target=181.25@prior_high" // no zone=
  };
  assert.throws(
    () => validateAnalysisResult(missingZoneExit, "exit"),
    /missing required v19 marker.*zone=/
  );

  const missingZoneFirstExit = {
    action: "SELL_LIMIT",
    orderPrice: "31.00",
    stopLossPrice: "28.50",
    hardStopPrice: "27.20",
    targetPrice: "31.00",
    currentPrice: "30.00",
    symbol: "TSLA",
    anchorSource: "prior_high",
    reasoning: "first-exit defaults to R1; target=31.00@prior_high" // no zone=
  };
  assert.throws(
    () => validateAnalysisResult(missingZoneFirstExit, "first_exit", { entryPrice: 30.00 }),
    /missing required v19 marker.*zone=/
  );
});

test("validateAnalysisResult: v19 empty reasoning rejected in all non-force-exit modes", () => {
  // Empty reasoning means AI didn't think — should never happen but
  // explicit check is cheap and catches regressions. Need per-mode fixtures
  // (different actions allowed per mode) so the action check passes first
  // and we exercise the reasoning empty-string check.
  const fixturesPerMode = {
    entry: { ...validEntryAnalysis, reasoning: "" },
    exit: {
      action: "SELL_LIMIT",
      orderPrice: "181.25",
      currentPrice: "180.70",
      symbol: "TSLA",
      anchorSource: "prior_high",
      reasoning: ""
    },
    first_exit: {
      action: "SELL_LIMIT",
      orderPrice: "31.00",
      stopLossPrice: "28.50",
      hardStopPrice: "27.20",
      targetPrice: "31.00",
      currentPrice: "30.00",
      symbol: "TSLA",
      anchorSource: "prior_high",
      reasoning: ""
    }
  };
  for (const [mode, analysis] of Object.entries(fixturesPerMode)) {
    const ctx = mode === "first_exit" ? { entryPrice: 30.00 } : undefined;
    assert.throws(
      () => validateAnalysisResult(analysis, mode, ctx),
      /empty reasoning/,
      `mode ${mode} should reject empty reasoning`
    );
  }
});

test("validateAnalysisResult: v19 reasoning markers are case-insensitive (R4 fix)", () => {
  // AI occasionally capitalizes markers (Current=, Mode=, Zone=). Strict
  // case-sensitive check would force a retry for cosmetic differences only.
  // Validator accepts mixed case to avoid that.
  const capitalizedEntry = {
    ...validEntryAnalysis,
    reasoning: "Current=180.70; Candidates=[R1=180.20@EMA20]; MODE=conservative; chose=180.20@EMA20"
  };
  assert.equal(validateAnalysisResult(capitalizedEntry, "entry"), capitalizedEntry);

  const capitalizedExit = {
    action: "SELL_LIMIT",
    orderPrice: "28.20",
    currentPrice: "27.50",
    symbol: "TSLA",
    anchorSource: "prior_high",
    reasoning: "Zone=healthy; trend=normal; target=28.20@prior_high"
  };
  assert.equal(validateAnalysisResult(capitalizedExit, "exit"), capitalizedExit);
});

test("validateAnalysisResult: v19 force_exit exempt from reasoning format requirements", () => {
  // force_exit is single-purpose (SELL_NOW only). Reasoning can be free-form
  // since action is locked and there's no judgment to audit.
  const forceExit = {
    action: "SELL_NOW",
    orderPrice: null,
    currentPrice: "180.50",
    symbol: "TSLA",
    anchorSource: "force_exit",
    reasoning: "close window"  // no markers, but force_exit is exempt
  };
  assert.equal(validateAnalysisResult(forceExit, "force_exit"), forceExit);
});

test("validateAnalysisResult: v19 entry mode=aggressive without ≥2 numbered evidence rejected", () => {
  // mode=aggressive must include at least (1) and (2) numbered evidence
  // markers in reasoning. Bare assertion fails.
  const noEvidence = {
    ...validEntryAnalysis,
    reasoning: "current=180.70; candidates=[R1=180.20@EMA20, R2=179.50@VWAP]; mode=aggressive; chose=179.50@VWAP",
    orderPrice: "179.50",
    anchorSource: "VWAP"
  };
  assert.throws(
    () => validateAnalysisResult(noEvidence, "entry"),
    /requires ≥2 numbered evidence items/
  );

  // Only (1), no (2) → still fail
  const oneEvidence = {
    ...noEvidence,
    reasoning: "current=180.70; candidates=[R1=180.20@EMA20, R2=179.50@VWAP]; mode=aggressive (evidence: (1) 3-bar lower highs); chose=179.50@VWAP"
  };
  assert.throws(
    () => validateAnalysisResult(oneEvidence, "entry"),
    /requires ≥2 numbered evidence items/
  );

  // Both (1) and (2) → pass
  const compliant = {
    ...noEvidence,
    reasoning: "current=180.70; candidates=[R1=180.20@EMA20, R2=179.50@VWAP]; mode=aggressive (evidence: (1) 3-bar lower highs 180.9->180.8->180.7; (2) R1-R2 spread 0.70 > R1-dist 0.50 × 1.4); chose=179.50@VWAP"
  };
  assert.equal(validateAnalysisResult(compliant, "entry"), compliant);
});

test("validateAnalysisResult: v19 entry mode=conservative does not require numbered evidence (default action)", () => {
  // Default conservative needs no extra justification — the prompt explicitly
  // allows a brief reasoning. Only aggressive requires numbered evidence.
  const conservativeBrief = {
    ...validEntryAnalysis,
    reasoning: "current=180.70; candidates=[R1=180.20@EMA20]; mode=conservative (default); chose=180.20@EMA20"
  };
  assert.equal(validateAnalysisResult(conservativeBrief, "entry"), conservativeBrief);
});

test("validateAnalysisResult: v19 exit observation flow=push-rebound requires ≥2 numbered evidence", () => {
  // Observation zone 走止盈 = aggressive choice (default is 走解套). Needs
  // numbered evidence in reasoning.
  const noEvidence = {
    action: "SELL_LIMIT",
    orderPrice: "28.20",
    currentPrice: "27.20",
    symbol: "TSLA",
    anchorSource: "prior_high",
    reasoning: "zone=observation; flow=push-rebound; target=28.20@prior_high"
  };
  assert.throws(
    () => validateAnalysisResult(noEvidence, "exit"),
    /requires ≥2 numbered evidence items/
  );

  const compliant = {
    ...noEvidence,
    reasoning: "zone=observation; flow=push-rebound (evidence: (1) 3-bar lows 27.15->27.18->27.20; (2) reclaimed EMA20=27.10 with VWAP=27.15); target=28.20@prior_high"
  };
  assert.equal(validateAnalysisResult(compliant, "exit"), compliant);

  // Default recovery flow doesn't need numbered evidence
  const recoveryBrief = {
    ...noEvidence,
    orderPrice: "27.55",
    anchorSource: "conservative_estimate",
    reasoning: "zone=observation; flow=recovery (default: evidence not conclusive); target=27.55@conservative_estimate"
  };
  assert.equal(validateAnalysisResult(recoveryBrief, "exit"), recoveryBrief);
});

test("validateAnalysisResult: v19 exit caution target=aggressive requires ≥2 numbered evidence", () => {
  // Caution zone 激进 (anchorSource=aggressive_recovery) is an active choice.
  // Needs numbered evidence in reasoning.
  const cautionContext = { entryPrice: 27.50, softStop: 27.00, hardStop: 26.30 };
  const noEvidence = {
    action: "SELL_LIMIT",
    orderPrice: "27.55",
    currentPrice: "26.95",  // caution zone
    symbol: "TSLA",
    anchorSource: "aggressive_recovery",
    reasoning: "zone=caution; target=aggressive=27.55@aggressive_recovery"
  };
  assert.throws(
    () => validateAnalysisResult(noEvidence, "exit", cautionContext),
    /requires ≥2 numbered evidence items/
  );

  const compliant = {
    ...noEvidence,
    reasoning: "zone=caution; target=aggressive=27.55@aggressive_recovery (evidence: (1) 3-bar lows 26.55->26.78->26.95 rising; (2) reclaimed EMA20=26.92 + 1.8x volume); only 0.05 from softStop"
  };
  assert.equal(validateAnalysisResult(compliant, "exit", cautionContext), compliant);
});

test("validateAnalysisResult: v19 fuzzy word blacklist enforced on aggressive reasoning", () => {
  // Even with (1) and (2) markers, fuzzy adjectives without numeric backing
  // are rejected. Forces AI to express evidence concretely.
  //
  // NOTE: standalone `bullish` / `bearish` are NOT in the blacklist because
  // they appear in legitimate pattern names ("bullish engulfing 26.5→27.0",
  // "bearish flag broken at 27.20"). The blacklist targets only the bare
  // fuzzy phrases that DON'T require numbers ("looks bullish", "feels strong",
  // "momentum building" etc.) — see test below for confirmation that the
  // compound forms ARE banned and the standalone forms now pass.
  const fuzzyWords = [
    "looks like a reversal",
    "looks bullish here",
    "feels strong on this bar",
    "seems like recovery",
    "should rebound soon",
    "probably continues up",
    "likely to bounce",
    "momentum building nicely"
  ];

  for (const phrase of fuzzyWords) {
    const fuzzy = {
      ...validEntryAnalysis,
      reasoning: `current=180.70; candidates=[R1=180.20@EMA20, R2=179.50@VWAP]; mode=aggressive (evidence: (1) 3-bar pattern; (2) ${phrase}); chose=179.50@VWAP`,
      orderPrice: "179.50",
      anchorSource: "VWAP"
    };
    assert.throws(
      () => validateAnalysisResult(fuzzy, "entry"),
      /fuzzy word\/phrase/,
      `phrase "${phrase}" should be rejected`
    );
  }
});

test("validateAnalysisResult: v19 standalone bullish/bearish allowed in aggressive reasoning (legitimate pattern names)", () => {
  // R2 fix: standalone "bullish" / "bearish" are common in technical pattern
  // names (bullish engulfing, bearish flag, bullish reclaim) which ARE
  // concrete observations backed by numbers. Banning the standalone words
  // would block compliant reasoning. The blacklist only targets the
  // compound forms (looks bullish, feels strong, momentum building) which
  // are the actual failure mode.
  const legitimateCompounds = [
    "bullish engulfing 26.5->27.0 with 1.8x volume",
    "bearish flag broken at 27.20 down to 26.50",
    "bullish reclaim of EMA20=26.92 with rising lows 26.5->26.7->26.9"
  ];
  for (const phrase of legitimateCompounds) {
    const compliant = {
      ...validEntryAnalysis,
      reasoning: `current=180.70; candidates=[R1=180.20@EMA20, R2=179.50@VWAP]; mode=aggressive (evidence: (1) ${phrase}; (2) 3-bar lower highs 30.40->30.20->30.10); chose=179.50@VWAP`,
      orderPrice: "179.50",
      anchorSource: "VWAP"
    };
    assert.equal(validateAnalysisResult(compliant, "entry"), compliant);
  }
});

test("validateAnalysisResult: v19 fuzzy words allowed in conservative/default reasoning (no enforcement)", () => {
  // The fuzzy-word ban only fires for aggressive choices. Conservative
  // reasoning can use natural language freely since it's the default
  // action and doesn't need defensive constraints.
  const conservativeWithFuzzy = {
    ...validEntryAnalysis,
    reasoning: "current=180.70; candidates=[R1=180.20@EMA20]; mode=conservative (looks fine, default); chose=180.20@EMA20"
  };
  assert.equal(validateAnalysisResult(conservativeWithFuzzy, "entry"), conservativeWithFuzzy);
});

test("validateAnalysisResult: v19 reasoning chose=<price>@<anchor> cross-check with orderPrice + anchorSource fields", () => {
  // Cross-check: declared chose=<price>@<anchor> in reasoning text must
  // match orderPrice + anchorSource fields (price tolerance ±$0.05 for
  // placement micro-adjust, anchor must match exactly).

  // Mismatched price (beyond tolerance): reasoning says 180.20, field says 179.00
  const priceMismatch = {
    ...validEntryAnalysis,
    orderPrice: "179.00",  // out of tolerance vs reasoning's 180.20
    reasoning: "current=180.70; candidates=[R1=180.20@EMA20]; mode=conservative; chose=180.20@EMA20"
  };
  assert.throws(
    () => validateAnalysisResult(priceMismatch, "entry"),
    /Cross-check failed.*tolerance/
  );

  // Mismatched anchor: reasoning says @EMA20, field says VWAP
  const anchorMismatch = {
    ...validEntryAnalysis,
    anchorSource: "VWAP",
    reasoning: "current=180.70; candidates=[R1=180.20@EMA20]; mode=conservative; chose=180.20@EMA20"
  };
  assert.throws(
    () => validateAnalysisResult(anchorMismatch, "entry"),
    /Cross-check failed — reasoning anchor and field anchor must match/
  );

  // Within tolerance: reasoning 180.20, field 180.22 (2 cents = placement micro-adjust)
  const withinTolerance = {
    ...validEntryAnalysis,
    orderPrice: "180.22",
    reasoning: "current=180.70; candidates=[R1=180.20@EMA20]; mode=conservative; chose=180.20@EMA20"
  };
  assert.equal(validateAnalysisResult(withinTolerance, "entry"), withinTolerance);
});

test("validateAnalysisResult: v19 cross-check handles R1=/R2= and conservative=/aggressive= prefix variants", () => {
  // Healthy-zone reasoning often uses inline rank labels like
  // `target=R1=28.20@prior_high` or `target=R2=29.00@gap`. Caution-zone
  // aggressive uses `target=aggressive=27.55@aggressive_recovery`. The
  // cross-check regex must accept these prefixes and still extract
  // PRICE + ANCHOR correctly.

  // R1=PRICE@ANCHOR variant (healthy zone style)
  const r1Variant = {
    action: "SELL_LIMIT",
    orderPrice: "28.20",
    currentPrice: "27.50",
    symbol: "TSLA",
    anchorSource: "prior_high",
    reasoning: "zone=healthy; trend=normal; target=R1=28.20@prior_high"
  };
  assert.equal(validateAnalysisResult(r1Variant, "exit"), r1Variant);

  // R2 variant
  const r2Variant = {
    ...r1Variant,
    orderPrice: "29.00",
    anchorSource: "gap",
    reasoning: "zone=healthy; trend=strong (3 green + rising); target=R2=29.00@gap (skip R1=28.50@prior_high)"
  };
  assert.equal(validateAnalysisResult(r2Variant, "exit"), r2Variant);

  // aggressive= prefix variant (caution zone)
  const aggVariant = {
    action: "SELL_LIMIT",
    orderPrice: "27.55",
    currentPrice: "26.95",
    symbol: "TSLA",
    anchorSource: "aggressive_recovery",
    reasoning: "zone=caution; target=aggressive=27.55@aggressive_recovery (evidence: (1) 3-bar pattern rising; (2) reclaimed EMA20)"
  };
  const cautionContext = { entryPrice: 27.50, softStop: 27.00, hardStop: 26.30 };
  assert.equal(validateAnalysisResult(aggVariant, "exit", cautionContext), aggVariant);

  // Prefix variant with MISMATCHED anchor should still fail cross-check
  const r1Mismatch = {
    ...r1Variant,
    anchorSource: "EMA200"  // reasoning says @prior_high, field says EMA200
  };
  assert.throws(
    () => validateAnalysisResult(r1Mismatch, "exit"),
    /Cross-check failed/
  );
});

test("validateAnalysisResult: v19 cross-check is skipped when reasoning has no chose=/target= clause", () => {
  // If reasoning happens to lack a "chose=" or "target=" clause (rare —
  // the forced format requires it, but validateReasoningFormat catches that
  // separately), the cross-check defensively does nothing rather than
  // throwing a misleading error.
  //
  // We can't construct this case via valid v19 entry reasoning (current=/
  // candidates/mode= markers don't include chose=), so we test it via a
  // pathological "all markers but no chose=" reasoning. Cross-check should
  // pass silently because there's nothing to compare.
  const noChose = {
    ...validEntryAnalysis,
    reasoning: "current=180.70; candidates=[R1=180.20@EMA20]; mode=conservative (default)"
    // intentionally lacks "chose=" — cross-check has nothing to match
  };
  assert.equal(validateAnalysisResult(noChose, "entry"), noChose);
});
