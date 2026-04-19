import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ACTIONS,
  ENTRY_MODE_ACTIONS,
  EXIT_MODE_ACTIONS,
  FORCE_EXIT_ACTIONS,
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

test("buildAnalysisPromptFromConfig: sanitizes URL (strips query)", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.ok(!prompt.includes("key=secret"));
  assert.match(prompt, /https:\/\/tradingview\.com\/chart/);
});
