import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ACTIONS,
  ENTRY_MODE_ACTIONS,
  EXIT_MODE_ACTIONS,
  FORCE_EXIT_ACTIONS,
  USER_CONTEXT_MAX_LENGTH,
  buildAnalysisPromptFromConfig,
  getAllowedActions
} from "../lib/llm.js";
import { getAnalysisPromptConfig } from "../lib/prompt-config.js";

test("ALLOWED_ACTIONS exported with six entries", () => {
  assert.deepEqual(
    [...ALLOWED_ACTIONS].sort(),
    ["BUY_LIMIT", "BUY_NOW", "HOLD", "SELL_LIMIT", "SELL_NOW", "WAIT"]
  );
});

test("getAllowedActions: entry mode allows only buy + wait", () => {
  assert.deepEqual(getAllowedActions("entry").sort(), ["BUY_LIMIT", "BUY_NOW", "WAIT"]);
});

test("getAllowedActions: default is entry", () => {
  assert.deepEqual(getAllowedActions().sort(), [...ENTRY_MODE_ACTIONS].sort());
});

test("getAllowedActions: exit mode allows sell + hold, never buy/wait", () => {
  const actions = getAllowedActions("exit");
  assert.deepEqual(actions.sort(), ["HOLD", "SELL_LIMIT", "SELL_NOW"]);
  assert.deepEqual(actions.sort(), [...EXIT_MODE_ACTIONS].sort());
  assert.ok(!actions.includes("BUY_NOW"));
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
        reason: "breakout continuation"
      }
    },
    "en"
  );
  assert.match(prompt, /\[SESSION_MODE\][\s\S]*EXIT/);
  assert.match(prompt, /\[POSITION_CONTEXT\]/);
  assert.match(prompt, /180\.50/);
  assert.match(prompt, /breakout continuation/);
  assert.match(prompt, /\[EXIT_MODE_RULES\]/);
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

test("buildAnalysisPromptFromConfig: required schema fields present", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  for (const key of ["entryPrice", "stopLossPrice", "targetPrice", "triggerCondition", "confidence"]) {
    assert.ok(prompt.includes(key), `prompt should mention ${key}`);
  }
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

test("buildAnalysisPromptFromConfig: Chinese mode requires triggerCondition in Chinese (regression: was leaking English)", () => {
  // Without an explicit rule, the model writes reasoning in Chinese but triggerCondition
  // in English by default — visible inconsistency in the user's recommendation card.
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "zh");
  assert.match(prompt, /triggerCondition in natural Simplified Chinese/);
  // Must also instruct the model to keep raw prices and English technical abbreviations
  // inside the Chinese sentence — otherwise we lose precision (e.g. AI translates 21.93
  // into something looser, or drops the VWAP keyword).
  assert.match(prompt, /raw decimal prices/i);
  assert.match(prompt, /VWAP \/ EMA \/ RSI in English/);
});

test("buildAnalysisPromptFromConfig: English mode also pins triggerCondition language explicitly", () => {
  // Symmetry: model defaults to English already, but being explicit is cheap and prevents
  // future drift if the prompt ever picks up multilingual influence from other sections.
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.match(prompt, /triggerCondition in English/);
});

test("buildAnalysisPromptFromConfig: entry mode injects RECENT_LESSONS when provided", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      recentLessons: [
        { symbol: "AAPL", pnlPercent: -0.75, exitTime: "2026-04-18T20:00:00Z", lesson: "Did not wait for volume confirmation on breakout." },
        { symbol: "TSLA", pnlPercent: 1.2, exitTime: "2026-04-17T20:30:00Z", lesson: "EMA20 bounce with clean stop worked." }
      ]
    },
    "en"
  );
  assert.match(prompt, /\[RECENT_LESSONS\]/);
  assert.match(prompt, /AAPL -0\.75%/);
  assert.match(prompt, /TSLA \+1\.20%/);
  assert.match(prompt, /volume confirmation/);
});

test("buildAnalysisPromptFromConfig: RECENT_LESSONS omitted in exit mode", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "exit",
      virtualPosition: { entryPrice: "180" },
      recentLessons: [{ symbol: "AAPL", pnlPercent: 1, exitTime: "2026-04-18T20:00:00Z", lesson: "x" }]
    },
    "en"
  );
  assert.ok(!/\[RECENT_LESSONS\]/.test(prompt));
});

test("buildAnalysisPromptFromConfig: RECENT_LESSONS omitted when list is empty", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    { ...samplePayload, mode: "entry", recentLessons: [] },
    "en"
  );
  assert.ok(!/\[RECENT_LESSONS\]/.test(prompt));
});

test("buildAnalysisPromptFromConfig: RECENT_LESSONS skips entries with empty lesson", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      recentLessons: [
        { symbol: "AAPL", pnlPercent: 0.5, lesson: "" },
        { symbol: "TSLA", pnlPercent: 1, lesson: "   " }
      ]
    },
    "en"
  );
  assert.ok(!/\[RECENT_LESSONS\]/.test(prompt));
});

test("buildAnalysisPromptFromConfig: RECENT_LESSONS includes entryAction + entryConfidence when provided", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      recentLessons: [
        { symbol: "AAPL", pnlPercent: -0.5, exitTime: "2026-04-18T20:00:00Z", entryAction: "BUY_NOW", entryConfidence: "high", lesson: "x" }
      ]
    },
    "en"
  );
  assert.match(prompt, /AAPL -0\.50% 2026-04-18 BUY_NOW\/high\]/);
});

test("buildAnalysisPromptFromConfig: RECENT_LESSONS omits action/confidence when both null (legacy trades)", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      recentLessons: [
        { symbol: "AAPL", pnlPercent: 1, exitTime: "2026-04-18T20:00:00Z", entryAction: null, entryConfidence: null, lesson: "y" }
      ]
    },
    "en"
  );
  // Legacy trade should render cleanly without trailing whitespace or stray slashes.
  assert.match(prompt, /\[AAPL \+1\.00% 2026-04-18\] y/);
});

test("buildAnalysisPromptFromConfig: LAST_SIGNAL_AND_ORDER injected in entry mode when lastSignal provided", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      lastSignal: {
        action: "WAIT",
        entryPrice: "180.50",
        stopLossPrice: "179.10",
        targetPrice: "183.00",
        currentPrice: "181.30",
        triggerCondition: "price pulls back to 180.50 +/- 0.10 and 5m candle closes above 180.50",
        confidence: "medium",
        reasoning: "waiting for volume confirmation"
      }
    },
    "en"
  );
  assert.match(prompt, /\[LAST_SIGNAL_AND_ORDER\]/);
  assert.match(prompt, /action=WAIT/);
  assert.match(prompt, /volume confirmation/);
  // Structured trigger + prior currentPrice must flow into the next round so the AI can
  // decide "trigger now met → upgrade WAIT to BUY_NOW".
  assert.match(prompt, /Previous trigger condition[^\n]*pulls back to 180\.50/);
  assert.match(prompt, /Previous round's observed current price: 181\.30/);
  assert.match(prompt, /CRITICAL: if the previous trigger condition is now satisfied/);
});

test("buildAnalysisPromptFromConfig: LAST_SIGNAL_AND_ORDER tolerates missing triggerCondition / currentPrice (legacy rounds)", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      lastSignal: { action: "WAIT", reasoning: "legacy round" }
      // no currentPrice, no triggerCondition
    },
    "en"
  );
  assert.match(prompt, /Previous round's observed current price: \?/);
  assert.match(prompt, /Previous trigger condition[^\n]*not recorded/);
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
        confidence: "high",
        placedAt: new Date(Date.now() - 5 * 60000).toISOString()
      }
    },
    "en"
  );
  assert.match(prompt, /\[LAST_SIGNAL_AND_ORDER\]/);
  assert.match(prompt, /BUY_LIMIT order at \$180\.50/);
  assert.match(prompt, /still resting/);
  assert.match(prompt, /SAME action and SAME numbers/);
});

test("buildAnalysisPromptFromConfig: LAST_SIGNAL_AND_ORDER injected in exit mode", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "exit",
      virtualPosition: { entryPrice: "180.50" },
      lastSignal: { action: "HOLD", reasoning: "trend still up" }
    },
    "en"
  );
  assert.match(prompt, /\[LAST_SIGNAL_AND_ORDER\]/);
  assert.match(prompt, /action=HOLD/);
});

test("buildAnalysisPromptFromConfig: LAST_SIGNAL_AND_ORDER omitted in force_exit mode", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "force_exit",
      virtualPosition: { entryPrice: "180.50" },
      lastSignal: { action: "HOLD", reasoning: "x" },
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

test("buildAnalysisPromptFromConfig: USER_CONTEXT injected when userContext provided (entry)", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      userContext: "Stock at all-time high after 3 up-days. Earnings next Tuesday."
    },
    "en"
  );
  assert.match(prompt, /\[USER_CONTEXT\]/);
  assert.match(prompt, /all-time high/);
  assert.match(prompt, /Earnings next Tuesday/);
  // Bias meta-rule MUST be present so the model knows to distinguish facts from opinions.
  assert.match(prompt, /USER BIAS/);
  assert.match(prompt, /do NOT let them override what the current chart actually shows/);
});

test("buildAnalysisPromptFromConfig: USER_CONTEXT also injected in exit mode (fundamentals matter for exits too)", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "exit",
      virtualPosition: { entryPrice: "180" },
      userContext: "Earnings tomorrow AMC — consider exiting early."
    },
    "en"
  );
  assert.match(prompt, /\[USER_CONTEXT\]/);
  assert.match(prompt, /Earnings tomorrow/);
});

test("buildAnalysisPromptFromConfig: USER_CONTEXT also injected in force_exit mode", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "force_exit",
      virtualPosition: { entryPrice: "180" },
      userContext: "Watch for closing auction imbalance."
    },
    "en"
  );
  assert.match(prompt, /\[USER_CONTEXT\]/);
  assert.match(prompt, /closing auction/);
});

test("buildAnalysisPromptFromConfig: USER_CONTEXT omitted when absent / empty / whitespace", () => {
  for (const userContext of [undefined, null, "", "   ", "\n\n  \t"]) {
    const prompt = buildAnalysisPromptFromConfig(
      getAnalysisPromptConfig(),
      { ...samplePayload, mode: "entry", userContext },
      "en"
    );
    assert.ok(!/\[USER_CONTEXT\]/.test(prompt), `should omit for value: ${JSON.stringify(userContext)}`);
  }
});

test("buildAnalysisPromptFromConfig: USER_CONTEXT truncated at USER_CONTEXT_MAX_LENGTH", () => {
  const long = "x".repeat(USER_CONTEXT_MAX_LENGTH + 50);
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    { ...samplePayload, mode: "entry", userContext: long },
    "en"
  );
  const match = prompt.match(/--- BEGIN NOTES ---\n([\s\S]*?)\n--- END NOTES ---/);
  assert.ok(match, "should contain notes block");
  assert.equal(match[1].length, USER_CONTEXT_MAX_LENGTH);
});

test("USER_CONTEXT_MAX_LENGTH exported and is a reasonable cap", () => {
  assert.equal(typeof USER_CONTEXT_MAX_LENGTH, "number");
  assert.ok(USER_CONTEXT_MAX_LENGTH >= 200 && USER_CONTEXT_MAX_LENGTH <= 2000);
});

test("buildAnalysisPromptFromConfig: prompt teaches AI to use Volume + VWAP", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  // Focus areas must name both signals.
  assert.match(prompt, /VWAP/);
  assert.match(prompt, /volume/i);
  // Guardrail: must forbid hallucinating either when not drawn.
  assert.match(prompt, /hallucinating a VWAP line or volume pattern/);
  // Execution rule: low-volume breakouts must not produce BUY_NOW.
  assert.match(prompt, /low-volume breakout/);
  // Confidence must be conditioned on volume/VWAP agreement.
  assert.match(prompt, /volume and VWAP[\s\S]*agree with the direction/);
});

test("buildAnalysisPromptFromConfig: sanitizes URL (strips query)", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.ok(!prompt.includes("key=secret"));
  assert.match(prompt, /https:\/\/tradingview\.com\/chart/);
});

// ---- LONG_TERM_CONTEXT injection ----------------------------------------------------------

const longTermFresh = {
  timeframe: "daily",
  summary: "Stock in clear uptrend, post-breakout from 6-month base. Closest resistance at 200/210, support at 180/175.",
  trend: "up",
  stage: "breakout",
  keySupport: "180, 175",
  keyResistance: "200, 210",
  symbol: "TSLA",
  generatedAt: new Date().toISOString()
};

test("buildAnalysisPromptFromConfig: LONG_TERM_CONTEXT injected in entry mode with anti-bias rules", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    { ...samplePayload, mode: "entry", longTermContext: longTermFresh },
    "en"
  );
  assert.match(prompt, /\[LONG_TERM_CONTEXT\]/);
  assert.match(prompt, /Higher-timeframe \(daily\)/);
  assert.match(prompt, /Trend: up/);
  assert.match(prompt, /Stage: breakout/);
  assert.match(prompt, /Key support: 180, 175/);
  assert.match(prompt, /Key resistance: 200, 210/);
  assert.match(prompt, /post-breakout from 6-month base/);
  // Anti-bias rules MUST be present so a long-term tag cannot steamroll the 5-min signal.
  assert.match(prompt, /structural bias only/);
  assert.match(prompt, /5-min chart is the trigger/);
  assert.match(prompt, /do NOT let long-term bullishness override/i);
  assert.match(prompt, /lower confidence by one tier/);
});

test("buildAnalysisPromptFromConfig: LONG_TERM_CONTEXT also injected in exit + force_exit modes", () => {
  for (const mode of ["exit", "force_exit"]) {
    const prompt = buildAnalysisPromptFromConfig(
      getAnalysisPromptConfig(),
      { ...samplePayload, mode, virtualPosition: { entryPrice: "180" }, longTermContext: longTermFresh },
      "en"
    );
    assert.match(prompt, /\[LONG_TERM_CONTEXT\]/, `should inject in ${mode}`);
    assert.match(prompt, /post-breakout from 6-month base/);
  }
});

test("buildAnalysisPromptFromConfig: LONG_TERM_CONTEXT omitted when missing / empty / null", () => {
  for (const longTermContext of [undefined, null, {}, { summary: "" }, { summary: "   " }]) {
    const prompt = buildAnalysisPromptFromConfig(
      getAnalysisPromptConfig(),
      { ...samplePayload, mode: "entry", longTermContext },
      "en"
    );
    assert.ok(!/\[LONG_TERM_CONTEXT\]/.test(prompt), `should omit for: ${JSON.stringify(longTermContext)}`);
  }
});

test("buildAnalysisPromptFromConfig: LONG_TERM_CONTEXT shows staleness warning when >24h old", () => {
  const stale = {
    ...longTermFresh,
    generatedAt: new Date(Date.now() - 30 * 3600 * 1000).toISOString() // 30h ago
  };
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    { ...samplePayload, mode: "entry", longTermContext: stale },
    "en"
  );
  assert.match(prompt, /more than 24 hours old/);
  assert.match(prompt, /potentially stale/);
});

test("buildAnalysisPromptFromConfig: LONG_TERM_CONTEXT does NOT show staleness when fresh", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    { ...samplePayload, mode: "entry", longTermContext: longTermFresh },
    "en"
  );
  assert.ok(!/more than 24 hours old/.test(prompt));
});

test("buildAnalysisPromptFromConfig: LONG_TERM_CONTEXT placed after USER_CONTEXT, before LAST_SIGNAL_AND_ORDER", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      userContext: "Earnings tomorrow.",
      longTermContext: longTermFresh,
      lastSignal: { action: "WAIT", reasoning: "x" }
    },
    "en"
  );
  const userIdx = prompt.indexOf("[USER_CONTEXT]");
  const longIdx = prompt.indexOf("[LONG_TERM_CONTEXT]");
  const lastIdx = prompt.indexOf("[LAST_SIGNAL_AND_ORDER]");
  assert.ok(userIdx >= 0 && longIdx >= 0 && lastIdx >= 0);
  assert.ok(userIdx < longIdx, "USER_CONTEXT should come before LONG_TERM_CONTEXT");
  assert.ok(longIdx < lastIdx, "LONG_TERM_CONTEXT should come before LAST_SIGNAL_AND_ORDER");
});
