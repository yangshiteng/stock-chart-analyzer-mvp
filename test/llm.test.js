import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_ACTIONS, buildAnalysisPromptFromConfig, getAllowedActions } from "../lib/llm.js";
import { getAnalysisPromptConfig } from "../lib/prompt-config.js";

test("getAllowedActions: fixed semi-auto enum", () => {
  assert.deepEqual(
    getAllowedActions().sort(),
    ["BUY_LIMIT", "BUY_NOW", "SELL_LIMIT", "SELL_NOW", "WAIT"]
  );
});

test("ALLOWED_ACTIONS exported with five entries", () => {
  assert.deepEqual(
    [...ALLOWED_ACTIONS].sort(),
    ["BUY_LIMIT", "BUY_NOW", "SELL_LIMIT", "SELL_NOW", "WAIT"]
  );
});

const samplePayload = {
  pageTitle: "TSLA Stock Chart",
  pageUrl: "https://tradingview.com/chart?key=secret",
  symbolHint: "TSLA"
};

test("buildAnalysisPromptFromConfig: required schema fields present", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  for (const key of ["entryPrice", "stopLossPrice", "targetPrice", "triggerCondition", "confidence"]) {
    assert.ok(prompt.includes(key), `prompt should mention ${key}`);
  }
});

test("buildAnalysisPromptFromConfig: includes EXECUTION_RULES section", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.match(prompt, /\[EXECUTION_RULES\]/);
});

test("buildAnalysisPromptFromConfig: no capital/position context leaked", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.ok(!/USER_CONTEXT/.test(prompt));
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

test("buildAnalysisPromptFromConfig: sanitizes URL (strips query)", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.ok(!prompt.includes("key=secret"));
  assert.match(prompt, /https:\/\/tradingview\.com\/chart/);
});
