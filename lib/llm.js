import { getAnalysisPromptConfig } from "./prompt-config.js";
import { getLanguage } from "./i18n.js";
import { getSettings } from "./storage.js";
import { guessSymbol, sanitizeUrl } from "./symbol.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ANALYSIS_MAX_OUTPUT_TOKENS = 1200;
const MARKET_CONTEXT_SCAN_MAX_OUTPUT_TOKENS = 1100;
const RETRY_MAX_ATTEMPTS = 3;
const ANALYSIS_VALIDATION_MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1000;
const MARKET_CONTEXT_REGIMES = ["uptrend", "range", "downtrend"];
// Key-level types are now STATIC FORMATIONS only. Role (support/resistance) is
// resolved dynamically at 5-minute analysis time based on current price — a
// level below current price acts as support, above acts as resistance, and the
// role swaps when price crosses through (TA's "polarity inversion" principle).
const MARKET_CONTEXT_LEVEL_TYPES = ["pivot", "gap", "prior_high", "prior_low"];
// Anchor sources for BUY_LIMIT / SELL_LIMIT decisions. The AI must report
// which level it picked: static (from MARKET_CONTEXT) or dynamic (live chart).
// `conservative_estimate` is the fallback when no key level exists in the
// relevant direction.
const ANCHOR_SOURCES = [
  "EMA20", "EMA50", "EMA100", "EMA200", "VWAP",
  "pivot", "gap", "prior_high", "prior_low",
  "conservative_estimate"
];

// Action vocabulary (post key-levels redesign):
// - BUY_LIMIT: only entry action; orderPrice is the chosen support below current
// - SELL_LIMIT: default exit action; orderPrice is the chosen resistance above current
// - SELL_NOW: hard exit when recorded stop is broken OR in force_exit window
// WAIT and HOLD were removed — every round always returns one of the above.
const ALLOWED_ACTIONS = ["BUY_LIMIT", "SELL_NOW", "SELL_LIMIT"];
const ENTRY_MODE_ACTIONS = ["BUY_LIMIT"];
const EXIT_MODE_ACTIONS = ["SELL_NOW", "SELL_LIMIT"];
const FORCE_EXIT_ACTIONS = ["SELL_NOW"];

function buildAnalysisJsonSchema(allowedActions) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: allowedActions
      },
      orderPrice: { anyOf: [{ type: "string" }, { type: "null" }] },
      entryPrice: { anyOf: [{ type: "string" }, { type: "null" }] },
      stopLossPrice: { anyOf: [{ type: "string" }, { type: "null" }] },
      targetPrice: { anyOf: [{ type: "string" }, { type: "null" }] },
      reasoning: { type: "string" },
      symbol: {
        anyOf: [{ type: "string" }, { type: "null" }]
      },
      currentPrice: { type: "string" },
      anchorSource: { type: "string" }
    },
    required: [
      "action",
      "orderPrice",
      "entryPrice",
      "stopLossPrice",
      "targetPrice",
      "reasoning",
      "symbol",
      "currentPrice",
      "anchorSource"
    ]
  };
}

function parseJsonResponse(rawText, label) {
  const normalized = rawText.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");

  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error(`${label} response was not valid JSON: ${error.message}`);
  }
}

function formatList(items) {
  return items.join(", ");
}

function formatSection(title, lines) {
  return [`[${title}]`, ...lines].join("\n");
}

function formatBulletSection(title, items) {
  return formatSection(title, items.map((item) => `- ${item}`));
}

function getAllowedActions(mode = "entry") {
  if (mode === "force_exit") {
    return [...FORCE_EXIT_ACTIONS];
  }
  if (mode === "exit") {
    return [...EXIT_MODE_ACTIONS];
  }
  return [...ENTRY_MODE_ACTIONS];
}

function normalizeMarketContextTimeframe(value) {
  return value === "1h" ? "1h" : "daily";
}

function buildMarketContextScanJsonSchema(expectedTimeframe) {
  const timeframe = normalizeMarketContextTimeframe(expectedTimeframe);
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      timeframe: {
        type: "string",
        enum: [timeframe]
      },
      regime: {
        type: "string",
        enum: MARKET_CONTEXT_REGIMES
      },
      keyLevels: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            type: {
              type: "string",
              enum: MARKET_CONTEXT_LEVEL_TYPES
            },
            timeframe: {
              type: "string",
              enum: [timeframe]
            },
            price: { type: "string" },
            zoneLow: { anyOf: [{ type: "string" }, { type: "null" }] },
            zoneHigh: { anyOf: [{ type: "string" }, { type: "null" }] },
            reason: { type: "string" }
          },
          required: ["label", "type", "timeframe", "price", "zoneLow", "zoneHigh", "reason"]
        }
      },
      riskNotes: { type: "string" }
    },
    required: ["timeframe", "regime", "keyLevels", "riskNotes"]
  };
}

function parsePriceField(value, fieldName) {
  const raw = `${value ?? ""}`.trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error(`Model returned invalid ${fieldName}: expected a single positive decimal price.`);
  }
  const price = Number(raw);
  if (!raw || !Number.isFinite(price) || price <= 0) {
    throw new Error(`Model returned invalid ${fieldName}: expected a single positive decimal price.`);
  }
  return price;
}

function parseNullablePriceField(value, fieldName) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return parsePriceField(value, fieldName);
}

function validateNoOrderPrice(analysis) {
  if (analysis.orderPrice !== null && analysis.orderPrice !== undefined && `${analysis.orderPrice}`.trim() !== "") {
    throw new Error(`Model returned invalid ${analysis.action}: orderPrice must be null when no order should be placed now.`);
  }
}

function validateLongSetupPrices(analysis, currentPrice) {
  const orderPrice = parsePriceField(analysis.orderPrice, "orderPrice");
  const stop = parsePriceField(analysis.stopLossPrice, "stopLossPrice");
  const target = parsePriceField(analysis.targetPrice, "targetPrice");

  // BUY_LIMIT must be at a key level BELOW current price. The key-levels
  // strategy explicitly excludes "marketable limit at current price" — every
  // BUY_LIMIT is a pre-placed bid at a level that price has to come down to.
  if (orderPrice >= currentPrice) {
    throw new Error("Model returned invalid BUY_LIMIT: orderPrice must be strictly below currentPrice (BUY_LIMIT is a pre-placed bid at a support key level below current price).");
  }

  if (stop >= orderPrice) {
    throw new Error("Model returned invalid long setup: stopLossPrice must be below orderPrice.");
  }

  if (target <= currentPrice) {
    throw new Error("Model returned invalid long setup: targetPrice must be above currentPrice.");
  }

  // R:R 1:1 floor was removed with the key-levels redesign: the user's edge
  // is aggregate (many small attempts at key levels with bounded stops), not
  // per-trade R:R. The chosen levels are what they are; if R:R is tight, the
  // user decides at the broker whether to actually place the limit.
}

function validateAnchorSource(analysis) {
  const anchor = `${analysis.anchorSource || ""}`.trim();
  if (!anchor) {
    throw new Error("Model returned missing anchorSource. Every BUY_LIMIT / SELL_LIMIT / SELL_NOW must cite the key level it was anchored to.");
  }
  // Free-string for now (don't hard-enforce the enum) — but we expect one of
  // the well-known values. Anything else implies the model invented an anchor.
  if (!ANCHOR_SOURCES.includes(anchor)) {
    // Soft warning via prompt; not a validator hard-fail. Allow but flag.
  }
}

function validateAnalysisResult(analysis, mode = "entry") {
  const normalizedMode = mode === "exit" || mode === "force_exit" ? mode : "entry";
  if (!analysis || typeof analysis !== "object") {
    throw new Error("Model returned an invalid analysis object.");
  }

  const allowedActions = getAllowedActions(normalizedMode);
  if (!allowedActions.includes(analysis.action)) {
    throw new Error(
      `Model returned action=${analysis.action || "missing"}, but ${normalizedMode} mode only allows ${formatList(allowedActions)}.`
    );
  }

  const currentPrice = parsePriceField(analysis.currentPrice, "currentPrice");
  parseNullablePriceField(analysis.entryPrice, "entryPrice");
  parseNullablePriceField(analysis.stopLossPrice, "stopLossPrice");
  parseNullablePriceField(analysis.targetPrice, "targetPrice");

  validateAnchorSource(analysis);

  if (analysis.action === "BUY_LIMIT") {
    validateLongSetupPrices(analysis, currentPrice);
  } else if (analysis.action === "SELL_LIMIT") {
    const orderPrice = parsePriceField(analysis.orderPrice, "orderPrice");
    if (normalizedMode === "exit" && orderPrice <= currentPrice) {
      throw new Error("Model returned invalid SELL_LIMIT: orderPrice must be strictly above currentPrice in exit mode (SELL_LIMIT is a take-profit limit at a resistance key level above current price).");
    }
  } else if (analysis.action === "SELL_NOW") {
    validateNoOrderPrice(analysis);
  }

  return analysis;
}

function validateMarketContextScanResult(scan, expectedTimeframe = "daily") {
  const timeframe = normalizeMarketContextTimeframe(expectedTimeframe);
  if (!scan || typeof scan !== "object") {
    throw new Error("Model returned an invalid market context scan object.");
  }

  if (scan.timeframe !== timeframe) {
    throw new Error(`Model returned timeframe=${scan.timeframe || "missing"}, expected ${timeframe}.`);
  }

  if (!MARKET_CONTEXT_REGIMES.includes(scan.regime)) {
    throw new Error("Model returned invalid market regime.");
  }

  if (!Array.isArray(scan.keyLevels)) {
    throw new Error("Model returned invalid keyLevels: expected an array.");
  }

  if (scan.keyLevels.length > 10) {
    throw new Error("Model returned too many keyLevels; maximum is 10.");
  }

  const keyLevels = scan.keyLevels.map((level, index) => {
    if (!level || typeof level !== "object") {
      throw new Error(`Model returned invalid keyLevels[${index}].`);
    }
    if (!MARKET_CONTEXT_LEVEL_TYPES.includes(level.type)) {
      throw new Error(`Model returned invalid keyLevels[${index}].type.`);
    }
    if (level.timeframe !== timeframe) {
      throw new Error(`Model returned invalid keyLevels[${index}].timeframe.`);
    }

    const price = `${level.price || ""}`.trim();
    parsePriceField(price, `keyLevels[${index}].price`);
    const zoneLow = parseNullablePriceField(level.zoneLow, `keyLevels[${index}].zoneLow`);
    const zoneHigh = parseNullablePriceField(level.zoneHigh, `keyLevels[${index}].zoneHigh`);
    if (zoneLow !== null && zoneHigh !== null && zoneLow > zoneHigh) {
      throw new Error(`Model returned invalid keyLevels[${index}] zone: zoneLow must be <= zoneHigh.`);
    }

    return {
      label: `${level.label || ""}`.trim().slice(0, 80) || price,
      type: level.type,
      timeframe: level.timeframe,
      price,
      zoneLow: level.zoneLow === null || level.zoneLow === undefined || level.zoneLow === ""
        ? null
        : `${level.zoneLow}`.trim(),
      zoneHigh: level.zoneHigh === null || level.zoneHigh === undefined || level.zoneHigh === ""
        ? null
        : `${level.zoneHigh}`.trim(),
      reason: `${level.reason || ""}`.trim().slice(0, 220)
    };
  });

  return {
    timeframe,
    regime: scan.regime,
    keyLevels,
    riskNotes: `${scan.riskNotes || ""}`.trim().slice(0, 400)
  };
}

function normalizeExpectedSymbol(value) {
  return `${value || ""}`.trim().toUpperCase();
}

function formatVirtualPositionLines(virtualPosition) {
  if (!virtualPosition) {
    return ["No existing position. You are scanning for an entry."];
  }
  const entry = virtualPosition.entryPrice || "unknown";
  const entryTime = virtualPosition.entryTime || "unknown";
  const stop = virtualPosition.stopLossPrice || "unspecified";
  const target = virtualPosition.targetPrice || "unspecified";
  const reason = virtualPosition.reason || "not recorded";
  const entryAnchor = virtualPosition.entryAnchorSource || "unknown";
  return [
    `User is already long (position opened at the broker and confirmed via Mark bought).`,
    `Entry price: ${entry}`,
    `Entry time (UTC): ${entryTime}`,
    `Recorded stop-loss (entry-time commitment, do not change): ${stop}`,
    `Initial target placeholder: ${target}`,
    `Entry anchor (where the BUY_LIMIT was placed): ${entryAnchor}`,
    `Entry thesis: ${reason}`
  ];
}

function buildLanguageOutputSection(language) {
  if (language === "zh") {
    return formatBulletSection("LANGUAGE_OUTPUT", [
      "Write reasoning in natural Simplified Chinese, ≤80 characters, concrete and specific.",
      "Keep action, anchorSource, and all schema keys exactly in English.",
      "Keep orderPrice, entryPrice, stopLossPrice, targetPrice, currentPrice, and symbol as raw decimal prices, null, or raw tickers — do not translate them."
    ]);
  }

  return formatBulletSection("LANGUAGE_OUTPUT", [
    "Return reasoning in English, ≤80 characters.",
    "Keep schema keys, action, and anchorSource exactly in English as required."
  ]);
}

function minutesSince(iso, now = new Date()) {
  if (!iso) return null;
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

function formatLastSignalAndOrderSection(lastSignal, pendingLimitOrder, mode) {
  // FORCE_EXIT locks action to SELL_NOW — continuity context is noise there.
  if (mode === "force_exit") return null;
  if (!lastSignal && !pendingLimitOrder) return null;

  const lines = [];

  if (pendingLimitOrder) {
    const held = minutesSince(pendingLimitOrder.placedAt);
    const heldText = Number.isFinite(held) ? `${held} minute(s) ago` : "at an unknown time";
    const priorAnchor = pendingLimitOrder.anchorSource || "unknown";
    lines.push(
      `The user has placed a ${pendingLimitOrder.action} order at $${pendingLimitOrder.limitPrice} ${heldText} and it is still resting (not filled).`,
      `Snapshot at placement: limit ${pendingLimitOrder.limitPrice}, stop ${pendingLimitOrder.stopLossPrice || "unspecified"}, target ${pendingLimitOrder.targetPrice || "unspecified"}, anchor source: ${priorAnchor}.`,
      "Rules for a resting limit (THREE outcomes — be explicit which one applies in reasoning):",
      `- ANCHOR UNCHANGED + VALUE UNCHANGED: same anchor (e.g., still EMA20) and EMA20 is at essentially the same price as when the limit was placed → return the SAME numbers (the user keeps the order resting).`,
      `- ANCHOR UNCHANGED + VALUE MOVED: same anchor source but the line has shifted (e.g., EMA20 went from 27.50 to 27.55 as new candles formed) → return NEW orderPrice aligned to the current value of that anchor. State in reasoning: "anchor shifted, realigning to ${pendingLimitOrder.anchorSource || 'anchor'} = NEW_PRICE". The user will cancel the old order and place the new one.`,
      `- ANCHOR INVALIDATED: the previous anchor no longer makes sense (e.g., price decisively broke through EMA20 and is now well below it; or a new key level has become more relevant) → switch to the new anchor entirely. State in reasoning the structural reason for the switch.`,
      `- Do NOT chase the current price by reflex — the key-levels strategy only adjusts numbers when the CHART STRUCTURE moved, not when the price ticked.`
    );
    if (lastSignal) {
      lines.push(
        `Prior round observed currentPrice: ${lastSignal.currentPrice || "?"}.`
      );
    }
  } else if (lastSignal) {
    const priorAnchor = lastSignal.anchorSource || "unknown";
    lines.push(
      `Your previous round recommended: action=${lastSignal.action}, orderPrice=${lastSignal.orderPrice ?? "null"}, stop=${lastSignal.stopLossPrice || "?"}, target=${lastSignal.targetPrice || "?"}, anchor=${priorAnchor}.`,
      `Previous round's observed currentPrice: ${lastSignal.currentPrice || "?"}.`,
      `Previous reasoning: ${lastSignal.reasoning || "not recorded"}.`,
      "Rules for continuity (THREE outcomes):",
      "- ANCHOR UNCHANGED + VALUE UNCHANGED: re-emit the same orderPrice with the same anchor.",
      "- ANCHOR UNCHANGED + VALUE MOVED: re-emit with the new anchor value (e.g., EMA20 has shifted) and note the realignment in reasoning.",
      "- ANCHOR INVALIDATED: switch to a different key level and note the structural reason.",
      "- The final decision must still anchor in the CURRENT chart; do not parrot old numbers."
    );
  }

  return formatSection("LAST_SIGNAL_AND_ORDER", lines);
}

function formatMarketContextSection(
  marketContext,
  footer = "Use this context as a higher-timeframe map, but the final action must still be executable from the current 5-minute screenshot."
) {
  const summary = marketContext?.summary || marketContext;
  if (!summary || typeof summary !== "object") {
    return null;
  }

  const lines = [
    `Regime: ${summary.regime || "unknown"}.`,
    `Risk notes: ${summary.riskNotes || "none recorded"}.`,
    "Key levels (role is dynamic — anything below current price acts as support, anything above acts as resistance; if price crosses a level, its role inverts):"
  ];

  const keyLevels = Array.isArray(summary.keyLevels) ? summary.keyLevels.slice(0, 10) : [];
  if (keyLevels.length === 0) {
    lines.push("- No static key levels were extracted from MARKET_CONTEXT. Use only dynamic levels from the live chart (EMA / VWAP).");
  } else {
    for (const level of keyLevels) {
      const zone = level.zoneLow && level.zoneHigh
        ? ` zone ${level.zoneLow}-${level.zoneHigh}`
        : "";
      lines.push(
        `- ${level.type || "pivot"} (${level.timeframe || "?"}) ${level.label || ""}: ${level.price || "?"}${zone}. ${level.reason || ""}`.trim()
      );
    }
  }

  if (footer) {
    lines.push(footer);
  }

  return formatSection("MARKET_CONTEXT", lines);
}

function buildAnalysisPromptFromConfig(config, payload, language) {
  const mode = payload.mode === "exit" || payload.mode === "force_exit" ? payload.mode : "entry";
  const allowedActions = getAllowedActions(mode);
  const sanitizedUrl = sanitizeUrl(payload.pageUrl);
  const symbolHint = payload.symbolHint || guessSymbol(payload.pageTitle, sanitizedUrl || payload.pageUrl) || "unknown";

  const modeLabel = mode === "force_exit" ? "FORCE_EXIT" : mode === "exit" ? "EXIT" : "ENTRY";

  const sections = [
    formatSection("ROLE", [config.role]),
    formatSection("OBJECTIVE", [config.objective]),
    formatSection("SESSION_MODE", [`Mode: ${modeLabel}.`]),
    formatSection("POSITION_CONTEXT", formatVirtualPositionLines(payload.virtualPosition))
  ];

  const marketContextSection = formatMarketContextSection(payload.marketContext);
  if (marketContextSection) {
    sections.push(marketContextSection);
  }

  const lastSignalSection = formatLastSignalAndOrderSection(payload.lastSignal, payload.pendingLimitOrder, mode);
  if (lastSignalSection) {
    sections.push(lastSignalSection);
  }

  sections.push(
    formatSection("CHART_CONTEXT", [
      `Page title: ${payload.pageTitle || "Unknown"}`,
      `Page URL: ${sanitizedUrl || "Unknown"}`,
      `Symbol hint: ${symbolHint}.`,
      "Use EMA 20/50/100/200 only if they are visible in the screenshot. Do not invent EMA relationships.",
      `Allowed actions in this call: ${formatList(allowedActions)}.`
    ]),
    formatBulletSection("CHART_FOCUS", config.chartFocusAreas),
    formatBulletSection("CHART_GUARDRAILS", config.chartGuardrails),
    formatBulletSection("ACTION_RULES", config.actionRules)
  );

  if (mode === "entry" && config.entryModeRules) {
    sections.push(formatBulletSection("ENTRY_MODE_RULES", config.entryModeRules));
  } else if (mode === "exit" && config.exitModeRules) {
    sections.push(formatBulletSection("EXIT_MODE_RULES", config.exitModeRules));
  } else if (mode === "force_exit" && config.forceExitRules) {
    sections.push(formatBulletSection("FORCE_EXIT_RULES", config.forceExitRules));
  }

  sections.push(
    formatBulletSection("EXECUTION_RULES", config.executionRules),
    formatBulletSection("LANGUAGE_RULES", config.languageRules),
    buildLanguageOutputSection(language),
    formatSection("OUTPUT_FORMAT", [
      "Return strict JSON only.",
      `Required fields: ${config.requiredFields}`
    ])
  );

  return sections.join("\n\n");
}

function buildMarketContextScanPrompt(payload, language) {
  const timeframe = normalizeMarketContextTimeframe(payload.timeframe);
  const sanitizedUrl = sanitizeUrl(payload.pageUrl);
  const symbolHint = payload.symbolHint || guessSymbol(payload.pageTitle, sanitizedUrl || payload.pageUrl) || "unknown";
  const setupLines = timeframe === "daily"
    ? [
        "The user should be on a TradingView Daily / 1D candlestick chart.",
        "Visible history should cover roughly 3-6 months.",
        "Candles, volume, and EMA 20 / 50 / 100 / 200 should be visible.",
        "VWAP should be temporarily hidden on Daily because session VWAP is not useful for this scan.",
        "Visible-range High / Low labels should be hidden; do not treat them as true support or resistance."
      ]
    : [
        "The user should be on a TradingView 1H / 60-minute candlestick chart.",
        "Visible history should cover roughly 5-20 trading days.",
        "Candles, volume, and EMA 20 / 50 / 100 / 200 should be visible.",
        "VWAP is optional on 1H. If it is visible, use it only as secondary context.",
        "Visible-range High / Low labels should be hidden; do not treat them as true support or resistance."
      ];
  const lang = language === "zh"
    ? "Write label, reason, and riskNotes in concise Simplified Chinese."
    : "Write label, reason, and riskNotes in concise English.";

  return [
    formatSection("ROLE", [
      "You are scanning higher-timeframe market context for a US equity day-trading assistant."
    ]),
    formatSection("OBJECTIVE", [
      "Classify the current short-term regime and extract actionable support / resistance levels that a later 5-minute execution prompt will use.",
      "This scan is context only. Do not give a buy/sell action."
    ]),
    formatSection("SCAN_TIMEFRAME", [
      `Expected timeframe: ${timeframe}.`
    ]),
    formatBulletSection("CHART_SETUP_REQUIREMENTS", setupLines),
    formatSection("CHART_CONTEXT", [
      `Page title: ${payload.pageTitle || "Unknown"}`,
      `Page URL: ${sanitizedUrl || "Unknown"}`,
      `Symbol hint: ${symbolHint}.`
    ]),
    formatBulletSection("REGIME_RULES", [
      "regime=uptrend when higher highs / higher lows are visible and price respects rising medium-term EMAs.",
      "regime=range when price is rotating between support and resistance or EMAs are mixed / flat.",
      "regime=downtrend when lower highs / lower lows dominate and rallies are rejected below falling medium-term EMAs."
    ]),
    formatBulletSection("KEY_LEVEL_RULES", [
      "Return at most 10 key levels total. Each level is a STATIC FORMATION on the chart — its role as support / resistance is decided dynamically at trade time based on current price (below current = support, above = resistance, and the role inverts when price crosses through).",
      "Prefer levels from repeated pivots, high-volume reversal candles, gap boundaries, prior breakout / breakdown zones, and clear range extremes.",
      "Do NOT classify strength. All extracted levels are equal — the trader handles selection at execution time based on proximity to current price and trend context.",
      "Do NOT label as 'support' or 'resistance'. Use the form-based types only: pivot (turning point), gap (gap boundary), prior_high (notable swing high), prior_low (notable swing low).",
      "price must be one concrete readable chart price. zoneLow / zoneHigh may define a narrow zone when the chart supports it; otherwise use null.",
      "Do not invent precise prices. If a level is not readable, omit it."
    ]),
    formatBulletSection("OUTPUT_RULES", [
      "Return strict JSON only.",
      "Do not include action, orderPrice, entryPrice, stopLossPrice, or targetPrice.",
      lang,
      "Required fields: {\"timeframe\": \"daily\" | \"1h\", \"regime\": \"uptrend\" | \"range\" | \"downtrend\", \"keyLevels\": KeyLevel[], \"riskNotes\": string}",
      "Each KeyLevel = {label, type: \"pivot\"|\"gap\"|\"prior_high\"|\"prior_low\", timeframe, price, zoneLow, zoneHigh, reason}. No strength field."
    ])
  ].join("\n\n");
}

function extractResponseText(responseData) {
  if (typeof responseData.output_text === "string" && responseData.output_text.trim()) {
    return responseData.output_text.trim();
  }

  const textParts = [];

  for (const item of responseData.output || []) {
    for (const content of item.content || []) {
      if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string") {
        textParts.push(content.text);
      }
    }
  }

  return textParts.join("\n").trim();
}

function extractRefusalText(responseData) {
  const refusalParts = [];

  for (const item of responseData.output || []) {
    for (const content of item.content || []) {
      if (content.type === "refusal" && typeof content.refusal === "string") {
        refusalParts.push(content.refusal);
      }
    }
  }

  return refusalParts.join("\n").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

async function callOpenAiOnce({ apiKey, model, userContent, schemaName, schema, maxOutputTokens }) {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: "low" },
      max_output_tokens: maxOutputTokens,
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema
        }
      },
      input: [
        {
          role: "user",
          content: userContent
        }
      ]
    })
  });

  const rawBody = await response.text();
  let responseData;

  try {
    responseData = JSON.parse(rawBody);
  } catch (error) {
    const parseError = new Error(`OpenAI returned non-JSON HTTP content: ${error.message}`);
    parseError.status = response.status;
    parseError.retryable = isRetryableStatus(response.status);
    throw parseError;
  }

  if (!response.ok) {
    const message = responseData.error?.message || `HTTP ${response.status}`;
    const httpError = new Error(`OpenAI request failed: ${message}`);
    httpError.status = response.status;
    httpError.retryable = isRetryableStatus(response.status);
    throw httpError;
  }

  if (responseData.status === "incomplete") {
    const reason = responseData.incomplete_details?.reason || "unknown_reason";
    const incompleteError = new Error(`OpenAI response was incomplete: ${reason}. Try again or reduce prompt/image size.`);
    incompleteError.retryable = reason === "max_output_tokens";
    throw incompleteError;
  }

  const refusalText = extractRefusalText(responseData);

  if (refusalText) {
    throw new Error(`OpenAI refused the request: ${refusalText}`);
  }

  const outputText = extractResponseText(responseData);

  if (!outputText) {
    throw new Error("OpenAI returned no text output.");
  }

  return outputText;
}

async function callOpenAi(options) {
  let lastError;

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await callOpenAiOnce(options);
    } catch (error) {
      lastError = error;

      let retryable;
      if (error.retryable !== undefined) {
        retryable = error.retryable === true;
      } else if (error.status === undefined) {
        retryable = true;
      } else {
        retryable = isRetryableStatus(error.status);
      }

      if (!retryable || attempt === RETRY_MAX_ATTEMPTS) {
        throw error;
      }

      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }

  throw lastError;
}

export async function analyzeChartCapture(payload) {
  const settings = await getSettings();
  const language = getLanguage(settings.language);

  if (!settings.openaiApiKey) {
    throw new Error("Add your OpenAI API key in the popup before starting monitoring.");
  }

  const mode = payload.mode === "exit" || payload.mode === "force_exit" ? payload.mode : "entry";
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), payload, language);
  const userContent = [
    { type: "input_text", text: prompt },
    { type: "input_image", image_url: payload.imageDataUrl, detail: "high" }
  ];

  let lastValidationError;
  for (let attempt = 1; attempt <= ANALYSIS_VALIDATION_MAX_ATTEMPTS; attempt += 1) {
    const rawText = await callOpenAi({
      apiKey: settings.openaiApiKey,
      model: settings.model || "gpt-5.4",
      userContent,
      schemaName: "stock_chart_execution_signal",
      schema: buildAnalysisJsonSchema(getAllowedActions(mode)),
      maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS
    });

    const parsed = parseJsonResponse(rawText, "Analysis");
    try {
      return validateAnalysisResult(parsed, mode);
    } catch (error) {
      lastValidationError = error;
      if (attempt === ANALYSIS_VALIDATION_MAX_ATTEMPTS) {
        throw error;
      }
    }
  }

  throw lastValidationError;
}

export async function analyzeMarketContextScan(payload) {
  const settings = await getSettings();
  const language = getLanguage(settings.language);

  if (!settings.openaiApiKey) {
    throw new Error("Add your OpenAI API key in the popup before starting monitoring.");
  }

  const timeframe = normalizeMarketContextTimeframe(payload.timeframe);
  const prompt = buildMarketContextScanPrompt({ ...payload, timeframe }, language);
  const userContent = [
    { type: "input_text", text: prompt },
    { type: "input_image", image_url: payload.imageDataUrl, detail: "high" }
  ];

  const rawText = await callOpenAi({
    apiKey: settings.openaiApiKey,
    model: settings.model || "gpt-5.4",
    userContent,
    schemaName: timeframe === "1h" ? "market_context_hourly_scan" : "market_context_daily_scan",
    schema: buildMarketContextScanJsonSchema(timeframe),
    maxOutputTokens: MARKET_CONTEXT_SCAN_MAX_OUTPUT_TOKENS
  });

  const parsed = parseJsonResponse(rawText, "Market context scan");
  return validateMarketContextScanResult(parsed, timeframe);
}

export {
  ALLOWED_ACTIONS,
  ENTRY_MODE_ACTIONS,
  EXIT_MODE_ACTIONS,
  FORCE_EXIT_ACTIONS,
  buildAnalysisPromptFromConfig,
  buildMarketContextScanPrompt,
  getAllowedActions,
  validateAnalysisResult,
  validateMarketContextScanResult
};
