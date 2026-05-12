import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ACTIONS,
  ENTRY_MODE_ACTIONS,
  EXIT_MODE_ACTIONS,
  FORCE_EXIT_ACTIONS,
  buildAnalysisPromptFromConfig,
  buildMarketContextScanPrompt,
  buildPremarketDipPlanPrompt,
  getAllowedActions,
  validateAnalysisResult,
  validateMarketContextScanResult,
  validatePremarketDipPlanResult
} from "../lib/llm.js";
import { getAnalysisPromptConfig } from "../lib/prompt-config.js";

test("ALLOWED_ACTIONS: BUY_NOW removed; SELL_NOW available for exits", () => {
  assert.deepEqual(
    [...ALLOWED_ACTIONS].sort(),
    ["BUY_LIMIT", "HOLD", "SELL_LIMIT", "SELL_NOW", "WAIT"]
  );
  assert.ok(!ALLOWED_ACTIONS.includes("BUY_NOW"), "BUY_NOW must not be reintroduced");
});

test("getAllowedActions: entry mode allows only BUY_LIMIT + WAIT", () => {
  assert.deepEqual(getAllowedActions("entry").sort(), ["BUY_LIMIT", "WAIT"]);
  assert.ok(!getAllowedActions("entry").includes("BUY_NOW"));
});

test("getAllowedActions: default is entry", () => {
  assert.deepEqual(getAllowedActions().sort(), [...ENTRY_MODE_ACTIONS].sort());
});

test("getAllowedActions: exit mode allows SELL_NOW + SELL_LIMIT + HOLD", () => {
  const actions = getAllowedActions("exit");
  assert.deepEqual(actions.sort(), ["HOLD", "SELL_LIMIT", "SELL_NOW"]);
  assert.deepEqual(actions.sort(), [...EXIT_MODE_ACTIONS].sort());
  assert.ok(!actions.includes("BUY_NOW"));
  assert.ok(!actions.includes("BUY_LIMIT"));
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
  aggression: "high",
  dipBuyPolicy: "aggressive",
  profitTakingStyle: "normal",
  keyLevels: [
    {
      label: "Prior breakout shelf",
      type: "support",
      strength: "strong",
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
        reason: "breakout continuation"
      },
      sellStrategy: {
        quickProfitDelta: "0.20",
        maxLossDelta: "0.30",
        quickProfitPrice: "180.70",
        maxLossPrice: "180.20"
      }
    },
    "en"
  );
  assert.match(prompt, /\[SESSION_MODE\][\s\S]*EXIT/);
  assert.match(prompt, /\[POSITION_CONTEXT\]/);
  assert.match(prompt, /180\.50/);
  assert.match(prompt, /Quick-profit trigger price: 180\.70/);
  assert.match(prompt, /Max-loss trigger price: 180\.20/);
  assert.match(prompt, /breakout continuation/);
  assert.match(prompt, /\[EXIT_MODE_RULES\]/);
  assert.match(prompt, /Allowed actions: SELL_NOW, SELL_LIMIT, HOLD/);
  assert.match(prompt, /default to SELL_NOW to lock the scalp profit/);
  assert.match(prompt, /orderPrice must be above currentPrice/);
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
  for (const key of ["orderPrice", "entryPrice", "stopLossPrice", "targetPrice", "confidence"]) {
    assert.ok(prompt.includes(key), `prompt should mention ${key}`);
  }
  assert.match(prompt, /Do not output triggerCondition/);
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
  assert.match(prompt, /Do not output triggerCondition/);
});

test("buildAnalysisPromptFromConfig: English mode uses orderPrice as the actionable price", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.match(prompt, /orderPrice/);
  assert.match(prompt, /Do not output triggerCondition/);
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
        action: "WAIT",
        orderPrice: null,
        entryPrice: null,
        stopLossPrice: "179.10",
        targetPrice: "183.00",
        currentPrice: "181.30",
        confidence: "medium",
        reasoning: "waiting for volume confirmation"
      }
    },
    "en"
  );
  assert.match(prompt, /\[LAST_SIGNAL_AND_ORDER\]/);
  assert.match(prompt, /action=WAIT/);
  assert.match(prompt, /orderPrice=null/);
  assert.match(prompt, /volume confirmation/);
  assert.match(prompt, /Previous round's observed current price: 181\.30/);
  assert.match(prompt, /WAIT can become BUY_LIMIT/);
  assert.doesNotMatch(prompt, /becomes BUY_NOW/);
  assert.doesNotMatch(prompt, /becomes SELL_NOW/);
});

test("buildAnalysisPromptFromConfig: LAST_SIGNAL_AND_ORDER tolerates missing orderPrice / currentPrice", () => {
  const prompt = buildAnalysisPromptFromConfig(
    getAnalysisPromptConfig(),
    {
      ...samplePayload,
      mode: "entry",
      lastSignal: { action: "WAIT", reasoning: "legacy round" }
    },
    "en"
  );
  assert.match(prompt, /orderPrice=null/);
  assert.match(prompt, /Previous round's observed current price: \?/);
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
      lastSignal: { action: "HOLD", orderPrice: null, reasoning: "trend still up" }
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

test("buildAnalysisPromptFromConfig: prompt teaches AI to use Volume + VWAP", () => {
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), samplePayload, "en");
  assert.match(prompt, /VWAP/);
  assert.match(prompt, /volume/i);
  assert.match(prompt, /hallucinating a VWAP line or volume pattern/);
  assert.match(prompt, /breakout-style BUY_LIMIT/);
  assert.match(prompt, /volume and VWAP[\s\S]*agree with the direction/);
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
  assert.match(prompt, /Dip-buy policy: aggressive/);
  assert.match(prompt, /Prior breakout shelf/);
  assert.match(prompt, /Market context gating/);
  assert.match(prompt, /visible-range high \/ low labels/i);
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
        type: "support",
        strength: "strong",
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

test("buildPremarketDipPlanPrompt: uses symbol, Market Context, fixed 10% threshold, and anti-FOMO rules", () => {
  const prompt = buildPremarketDipPlanPrompt(
    {
      symbol: "USAR",
      referenceClose: "27.42",
      marketContext: sampleMarketContext
    },
    "en"
  );

  assert.match(prompt, /\[PREMARKET_INPUTS\]/);
  assert.match(prompt, /Symbol: USAR/);
  assert.match(prompt, /User-entered yesterday close: 27\.42/);
  assert.match(prompt, /Fixed defensive dip threshold: 10%/);
  assert.match(prompt, /Reference dip price: 24\.68/);
  assert.match(prompt, /\[MARKET_CONTEXT\]/);
  assert.match(prompt, /Prior breakout shelf/);
  assert.match(prompt, /FOMO/);
  assert.match(prompt, /Do not request additional chart images/);
  assert.doesNotMatch(prompt, /input_image/);
});

test("validatePremarketDipPlanResult: accepts a conservative BUY_LIMIT plan", () => {
  const plan = validatePremarketDipPlanResult(
    {
      action: "BUY_LIMIT",
      symbol: "USAR",
      orderPrice: "24.70",
      stopLossPrice: "24.00",
      targetPrice: "25.60",
      confidence: "medium",
      referenceClose: "27.42",
      discountPercent: "10%",
      nearestSupport: "24.65",
      supportStrength: "strong",
      reasoning: "Near strong support at the fixed dip threshold."
    },
    {
      symbol: "USAR",
      referenceClose: "27.42"
    }
  );

  assert.equal(plan.action, "BUY_LIMIT");
  assert.equal(plan.symbol, "USAR");
  assert.equal(plan.orderPrice, "24.70");
  assert.equal(plan.nearestSupport, "24.65");
});

test("validatePremarketDipPlanResult: rejects shallow FOMO entries", () => {
  assert.throws(
    () => validatePremarketDipPlanResult(
      {
        action: "BUY_LIMIT",
        symbol: "USAR",
        orderPrice: "27.00",
        stopLossPrice: "26.50",
        targetPrice: "28.00",
        confidence: "high",
        referenceClose: "27.42",
        discountPercent: "10%",
        nearestSupport: "27.00",
        supportStrength: "medium",
        reasoning: "Chasing because the stock is strong."
      },
      {
        symbol: "USAR",
        referenceClose: "27.42"
      }
    ),
    /too close to yesterday's close/
  );
});

const validEntryAnalysis = {
  action: "BUY_LIMIT",
  orderPrice: "180.50",
  entryPrice: null,
  stopLossPrice: "179.50",
  targetPrice: "182.00",
  confidence: "medium",
  reasoning: "VWAP reclaim with rising volume",
  symbol: "TSLA",
  currentPrice: "180.70"
};

test("validateAnalysisResult: accepts a valid entry-mode long setup", () => {
  assert.equal(validateAnalysisResult(validEntryAnalysis, "entry"), validEntryAnalysis);
});

test("validateAnalysisResult: rejects action outside the current mode vocabulary", () => {
  assert.throws(
    () => validateAnalysisResult({ ...validEntryAnalysis, action: "SELL_NOW" }, "entry"),
    /only allows BUY_LIMIT, WAIT/
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

test("validateAnalysisResult: rejects entry setups whose stop is not below orderPrice", () => {
  assert.throws(
    () => validateAnalysisResult({ ...validEntryAnalysis, stopLossPrice: "181.00" }, "entry"),
    /stopLossPrice must be below orderPrice/
  );
});

test("validateAnalysisResult: rejects entry setups below 1:1 reward-to-risk", () => {
  assert.throws(
    () => validateAnalysisResult({ ...validEntryAnalysis, targetPrice: "181.00" }, "entry"),
    /at least 1:1/
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
    currentPrice: "180.10"
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
    entryPrice: "180.50"
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
    currentPrice: "180.70"
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

test("validateAnalysisResult: WAIT and HOLD reject orderPrice", () => {
  const wait = {
    ...validEntryAnalysis,
    action: "WAIT",
    orderPrice: null,
    entryPrice: null,
    stopLossPrice: null,
    targetPrice: null
  };
  const hold = {
    ...wait,
    action: "HOLD"
  };

  assert.equal(validateAnalysisResult(wait, "entry"), wait);
  assert.equal(validateAnalysisResult(hold, "exit"), hold);
  assert.throws(
    () => validateAnalysisResult({ ...wait, orderPrice: "180.50" }, "entry"),
    /orderPrice must be null/
  );
  assert.throws(
    () => validateAnalysisResult({ ...hold, orderPrice: "182.00" }, "exit"),
    /orderPrice must be null/
  );
});
