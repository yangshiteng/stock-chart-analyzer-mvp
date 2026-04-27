import { getAnalysisPromptConfig, getLongTermPromptConfig } from "./prompt-config.js";
import { getLanguage } from "./i18n.js";
import { getSettings } from "./storage.js";
import { guessSymbol, sanitizeUrl } from "./symbol.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ANALYSIS_MAX_OUTPUT_TOKENS = 1200;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

const ALLOWED_ACTIONS = ["BUY_NOW", "BUY_LIMIT", "SELL_NOW", "SELL_LIMIT", "HOLD", "WAIT"];
const ENTRY_MODE_ACTIONS = ["BUY_NOW", "BUY_LIMIT", "WAIT"];
const EXIT_MODE_ACTIONS = ["SELL_NOW", "SELL_LIMIT", "HOLD"];
const FORCE_EXIT_ACTIONS = ["SELL_NOW"];

// Hard upper bound on user-supplied background notes. Keeps the prompt bounded
// and discourages the user from pasting entire news articles — the note is meant
// to be a concise fact sheet, not a research dump.
export const USER_CONTEXT_MAX_LENGTH = 500;

// Long-term (higher-timeframe) context summary cap. Keeps the per-round prompt bounded
// since this section is injected on every 5-min analysis. 300 chars is enough for
// "uptrend, post-breakout, support 180/175, resistance 195/210" but not for an essay.
export const LONG_TERM_CONTEXT_MAX_SUMMARY = 300;
export const LONG_TERM_TIMEFRAMES = ["daily", "weekly"];
const LONG_TERM_MAX_OUTPUT_TOKENS = 700;

function buildAnalysisJsonSchema(allowedActions) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: allowedActions
      },
      entryPrice: { type: "string" },
      stopLossPrice: { type: "string" },
      targetPrice: { type: "string" },
      triggerCondition: { type: "string" },
      confidence: {
        type: "string",
        enum: ["low", "medium", "high"]
      },
      reasoning: { type: "string" },
      symbol: {
        anyOf: [{ type: "string" }, { type: "null" }]
      },
      currentPrice: { type: "string" }
    },
    required: [
      "action",
      "entryPrice",
      "stopLossPrice",
      "targetPrice",
      "triggerCondition",
      "confidence",
      "reasoning",
      "symbol",
      "currentPrice"
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

function formatVirtualPositionLines(virtualPosition) {
  if (!virtualPosition) {
    return ["No existing position. You are scanning for an entry."];
  }
  const entry = virtualPosition.entryPrice || "unknown";
  const entryTime = virtualPosition.entryTime || "unknown";
  const stop = virtualPosition.stopLossPrice || "unspecified";
  const target = virtualPosition.targetPrice || "unspecified";
  const reason = virtualPosition.reason || "not recorded";
  return [
    `User is already long (position opened at the broker and confirmed via Mark bought).`,
    `Entry price: ${entry}`,
    `Entry time (UTC): ${entryTime}`,
    `Planned stop-loss: ${stop}`,
    `Planned target: ${target}`,
    `Entry thesis: ${reason}`
  ];
}

function buildLanguageOutputSection(language) {
  if (language === "zh") {
    return formatBulletSection("LANGUAGE_OUTPUT", [
      "Write reasoning in natural Simplified Chinese, ≤80 characters, concrete and specific.",
      "Write triggerCondition in natural Simplified Chinese as well — it is shown to the user verbatim, so it must match the reasoning language. Embed raw decimal prices directly inside the Chinese sentence (e.g. '5 分钟收盘上破 21.93 且成交量大于过去 10 根 K 线均量'). Keep technical abbreviations VWAP / EMA / RSI in English.",
      "Keep action, confidence, and all schema keys exactly in English.",
      "Keep entryPrice, stopLossPrice, targetPrice, currentPrice, and symbol as raw decimal prices or raw tickers — do not translate them."
    ]);
  }

  return formatBulletSection("LANGUAGE_OUTPUT", [
    "Return reasoning in English, ≤80 characters.",
    "Return triggerCondition in English, plain prose with raw decimal prices.",
    "Keep schema keys, action, and confidence exactly in English as required."
  ]);
}

function formatRecentLessonsLines(lessons) {
  if (!Array.isArray(lessons) || lessons.length === 0) return null;
  const trimmed = lessons
    .filter((l) => l && typeof l.lesson === "string" && l.lesson.trim())
    .slice(0, 10);
  if (trimmed.length === 0) return null;
  return trimmed.map((l) => {
    const sym = l.symbol || "?";
    const pnl = Number.isFinite(l.pnlPercent)
      ? `${l.pnlPercent >= 0 ? "+" : ""}${l.pnlPercent.toFixed(2)}%`
      : "pnl?";
    const when = l.exitTime ? l.exitTime.slice(0, 10) : "";
    // entryAction + entryConfidence let the model calibrate against its own signal type
    // ("my high-confidence BUY_NOW still lost — downgrade this pattern next time").
    const meta = [l.entryAction, l.entryConfidence].filter(Boolean).join("/");
    const metaPart = meta ? ` ${meta}` : "";
    const lesson = l.lesson.trim().replace(/\s+/g, " ").slice(0, 180);
    return `- [${sym} ${pnl}${when ? " " + when : ""}${metaPart}] ${lesson}`;
  });
}

function minutesSince(iso, now = new Date()) {
  if (!iso) return null;
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

// User-supplied background notes (fundamentals, ATH context, earnings, macro, sector).
// Bias-resistant framing: explicitly separate verifiable facts from user
// predictions/sentiment and instruct the model not to let the user's opinions
// override what the chart shows. Included in ALL modes — fundamentals matter for
// both entry and exit decisions (e.g. "earnings tomorrow → consider exiting early").
function formatUserContextSection(userContext) {
  if (typeof userContext !== "string") return null;
  const trimmed = userContext.trim();
  if (!trimmed) return null;
  const capped = trimmed.slice(0, USER_CONTEXT_MAX_LENGTH);

  return formatSection("USER_CONTEXT", [
    "The user provided the following background notes about this ticker / market environment.",
    "--- BEGIN NOTES ---",
    capped,
    "--- END NOTES ---",
    "Rules for using these notes:",
    "- Treat verifiable facts (price levels, historical highs/lows, scheduled events like earnings dates, sector news) as true and factor them into your risk assessment.",
    "- Treat any user predictions, sentiment, or directional opinions (e.g. \"this will bounce\", \"this is overbought\") as USER BIAS — you may acknowledge them but do NOT let them override what the current chart actually shows.",
    "- If a note is directly relevant to your decision (e.g. you widened a stop because of pre-earnings volatility, or you downgraded confidence because price is at an all-time high), briefly name that note in reasoning so the user can verify the context was applied correctly.",
    "- Never fabricate agreement with user predictions to be polite. If the chart contradicts the user's view, say so."
  ]);
}

// Higher-timeframe (daily / weekly) structural read injected as context on EVERY 5-min round.
// The anti-bias rules at the bottom are critical — without them, a "long-term bullish" tag
// will steamroll a clean intraday breakdown signal. The 5-min chart is always the trigger;
// long-term is only an anchor for level realism and conflict awareness.
function formatLongTermContextSection(longTermContext, now = new Date()) {
  if (!longTermContext || typeof longTermContext !== "object") return null;
  const summary = typeof longTermContext.summary === "string" ? longTermContext.summary.trim() : "";
  if (!summary) return null;

  const tf = longTermContext.timeframe === "weekly" ? "weekly" : "daily";
  const trend = longTermContext.trend || "unclear";
  const stage = longTermContext.stage || "unclear";
  const support = longTermContext.keySupport || "not recorded";
  const resistance = longTermContext.keyResistance || "not recorded";
  const symbol = longTermContext.symbol || "unknown";

  const ageHours = longTermContext.generatedAt
    ? Math.max(0, Math.round((now.getTime() - Date.parse(longTermContext.generatedAt)) / 3600000))
    : null;
  const ageText = Number.isFinite(ageHours)
    ? `generated ${ageHours} hour(s) ago`
    : "generation time unknown";
  const stale = Number.isFinite(ageHours) && ageHours > 24;

  const lines = [
    `Higher-timeframe (${tf}) structural read for ${symbol}, ${ageText}:`,
    `- Trend: ${trend}`,
    `- Stage: ${stage}`,
    `- Key support: ${support}`,
    `- Key resistance: ${resistance}`,
    `- Summary: ${summary}`,
    "",
    "Rules for using this long-term context:",
    "- This is structural bias only. The 5-min chart is the trigger — every action you return must be justified on the 5-min, not on this long-term read.",
    "- Do NOT let long-term bullishness override a clear intraday breakdown, and do NOT let long-term bearishness override a clean intraday reclaim with volume.",
    "- If the long-term read and the current 5-min chart conflict (e.g. intraday breakout against a long-term downtrend, or intraday weakness inside a long-term uptrend), name the conflict in reasoning and lower confidence by one tier.",
    "- Use the long-term support/resistance as anchor checks: if your 5-min stop or target lands in a place that is unrealistic given these levels, adjust the level rather than the thesis.",
    "- Never repeat the long-term summary as the trade's reasoning — reasoning must describe the 5-min chart logic."
  ];

  if (stale) {
    lines.push(
      "- This long-term read is more than 24 hours old; treat it as potentially stale and weight the current 5-min chart more heavily. Mention staleness in reasoning if it materially changes the call."
    );
  }

  return formatSection("LONG_TERM_CONTEXT", lines);
}

function formatLastSignalAndOrderSection(lastSignal, pendingLimitOrder, mode) {
  // FORCE_EXIT locks action to SELL_NOW — continuity context is noise there.
  if (mode === "force_exit") return null;
  if (!lastSignal && !pendingLimitOrder) return null;

  const lines = [];

  if (pendingLimitOrder) {
    const held = minutesSince(pendingLimitOrder.placedAt);
    const heldText = Number.isFinite(held) ? `${held} minute(s) ago` : "at an unknown time";
    lines.push(
      `The user has placed a ${pendingLimitOrder.action} order at $${pendingLimitOrder.limitPrice} ${heldText} and it is still resting (not filled).`,
      `Snapshot at placement: entry ${pendingLimitOrder.limitPrice}, stop ${pendingLimitOrder.stopLossPrice || "unspecified"}, target ${pendingLimitOrder.targetPrice || "unspecified"}, confidence ${pendingLimitOrder.confidence || "unknown"}.`,
      "Rules for a resting limit:",
      `- If the current chart still supports this setup, return the SAME action and SAME numbers so the user keeps the order resting.`,
      `- If the setup is invalidated (price broke structure, momentum lost, thesis wrong, or the order is stale and unlikely to fill), explicitly say so in reasoning and return a revised signal — the user will cancel the old order and follow the new signal.`,
      `- Do NOT repeat the old numbers out of habit; verify against the current chart.`
    );
    // Prior-round continuity context also helps the AI understand how the market evolved
    // while the limit was resting (e.g. "previous trigger was a pullback to X, now satisfied").
    if (lastSignal) {
      lines.push(
        `Prior round (for context only): action=${lastSignal.action}, currentPrice=${lastSignal.currentPrice || "?"}, triggerCondition=${lastSignal.triggerCondition || "not recorded"}.`
      );
    }
  } else if (lastSignal) {
    lines.push(
      `Your previous round recommended: action=${lastSignal.action}, entry=${lastSignal.entryPrice || "?"}, stop=${lastSignal.stopLossPrice || "?"}, target=${lastSignal.targetPrice || "?"}, confidence=${lastSignal.confidence || "?"}.`,
      `Previous round's observed current price: ${lastSignal.currentPrice || "?"}.`,
      `Previous trigger condition (machine-checkable): ${lastSignal.triggerCondition || "not recorded"}.`,
      `Previous reasoning: ${lastSignal.reasoning || "not recorded"}.`,
      "Rules for continuity:",
      "- CRITICAL: if the previous trigger condition is now satisfied on this chart, you MAY upgrade the action accordingly — e.g. WAIT or BUY_LIMIT becomes BUY_NOW on entry side; HOLD or SELL_LIMIT becomes SELL_NOW on exit side. State in reasoning which condition was met.",
      "- If the chart still supports the previous call but the trigger has not yet fired, it is fine to restate the same signal.",
      "- If the setup is invalidated or a better one has emerged, return the revised signal and briefly note what changed in reasoning.",
      "- Every round must still anchor its final decision in the CURRENT chart — do not parrot old numbers without re-verifying them."
    );
  }

  return formatSection("LAST_SIGNAL_AND_ORDER", lines);
}

function buildAnalysisPromptFromConfig(config, payload, language) {
  const mode = payload.mode === "exit" || payload.mode === "force_exit" ? payload.mode : "entry";
  const allowedActions = getAllowedActions(mode);
  const sanitizedUrl = sanitizeUrl(payload.pageUrl);
  const symbolHint = payload.symbolHint || guessSymbol(payload.pageTitle, sanitizedUrl || payload.pageUrl) || "unknown";

  const modeLabel = mode === "force_exit" ? "FORCE_EXIT" : mode === "exit" ? "EXIT" : "ENTRY";
  const recentLessonsLines = mode === "entry" ? formatRecentLessonsLines(payload.recentLessons) : null;

  const sections = [
    formatSection("ROLE", [config.role]),
    formatSection("OBJECTIVE", [config.objective]),
    formatSection("SESSION_MODE", [`Mode: ${modeLabel}.`]),
    formatSection("POSITION_CONTEXT", formatVirtualPositionLines(payload.virtualPosition))
  ];

  if (recentLessonsLines) {
    sections.push(
      formatSection("RECENT_LESSONS", [
        "Lessons from this trader's recent closed trades. Let these adjust your bias but do NOT override what the current chart says.",
        ...recentLessonsLines
      ])
    );
  }

  const userContextSection = formatUserContextSection(payload.userContext);
  if (userContextSection) {
    sections.push(userContextSection);
  }

  // Long-term context goes AFTER user notes (so user-provided fundamentals come first
  // in narrative order) but BEFORE last-signal continuity (so the model reads structural
  // anchors before deciding whether to repeat the previous round's call).
  const longTermSection = formatLongTermContextSection(payload.longTermContext);
  if (longTermSection) {
    sections.push(longTermSection);
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

  const rawText = await callOpenAi({
    apiKey: settings.openaiApiKey,
    model: settings.model || "gpt-5.4",
    userContent,
    schemaName: "stock_chart_execution_signal",
    schema: buildAnalysisJsonSchema(getAllowedActions(mode)),
    maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS
  });

  return parseJsonResponse(rawText, "Analysis");
}

const LESSON_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    lesson: { type: "string" }
  },
  required: ["lesson"]
};

const LESSON_MAX_OUTPUT_TOKENS = 400;

function buildLessonPrompt(trade, language) {
  const lang = language === "zh"
    ? "Write ONE short lesson in natural Simplified Chinese, ≤80 characters."
    : "Write ONE short lesson in English, ≤80 characters.";

  const sym = trade.symbol || "?";
  const entry = trade.entryPrice || "?";
  const exit = trade.exitPrice || "?";
  const pnl = Number.isFinite(trade.pnlPercent)
    ? `${trade.pnlPercent >= 0 ? "+" : ""}${trade.pnlPercent.toFixed(2)}%`
    : "?";
  const plannedStop = trade.plannedStopLoss || "?";
  const plannedTarget = trade.plannedTarget || "?";
  const thesis = trade.reason || "not recorded";
  const heldMinutes = Number.isFinite(trade.heldMinutes) ? `${trade.heldMinutes}` : "?";

  return [
    formatSection("ROLE", [
      "You are a trading journal coach. Reflect on a single closed intraday day trade and produce ONE concrete lesson the trader should remember. No generic platitudes."
    ]),
    formatSection("TRADE_RECORD", [
      `Symbol: ${sym}`,
      `Entry price: ${entry}`,
      `Exit price: ${exit}`,
      `P&L: ${pnl}`,
      `Planned stop-loss at entry: ${plannedStop}`,
      `Planned target at entry: ${plannedTarget}`,
      `Held minutes: ${heldMinutes}`,
      `Entry thesis: ${thesis}`
    ]),
    formatBulletSection("RULES", [
      "Focus on what is actionable next time — a pattern, a discipline point, or a mistake to avoid.",
      "Never say 'good job' or 'keep it up'. If the trade worked, explain WHY it worked.",
      "If P&L is negative, name the specific error (stop too tight, chased entry, ignored trend, held past target, etc.) without moralizing.",
      lang
    ]),
    formatSection("OUTPUT_FORMAT", [
      "Return strict JSON only with a single field: {\"lesson\": string}"
    ])
  ].join("\n\n");
}

export async function generateTradeLesson(trade) {
  const settings = await getSettings();
  const language = getLanguage(settings.language);

  if (!settings.openaiApiKey) {
    throw new Error("OpenAI API key missing; cannot generate trade lesson.");
  }

  const prompt = buildLessonPrompt(trade, language);
  const userContent = [{ type: "input_text", text: prompt }];

  const rawText = await callOpenAi({
    apiKey: settings.openaiApiKey,
    model: settings.model || "gpt-5.4",
    userContent,
    schemaName: "trade_lesson",
    schema: LESSON_JSON_SCHEMA,
    maxOutputTokens: LESSON_MAX_OUTPUT_TOKENS
  });

  const parsed = parseJsonResponse(rawText, "Lesson");
  return (parsed.lesson || "").trim();
}

const LONG_TERM_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    trend: { type: "string", enum: ["up", "down", "range", "unclear"] },
    stage: { type: "string", enum: ["base", "breakout", "extended", "pullback", "topping", "reversal", "unclear"] },
    keySupport: { type: "string" },
    keyResistance: { type: "string" },
    symbol: { anyOf: [{ type: "string" }, { type: "null" }] }
  },
  required: ["summary", "trend", "stage", "keySupport", "keyResistance", "symbol"]
};

function buildLongTermPrompt(config, payload, language) {
  const tf = payload.timeframe === "weekly" ? "weekly" : "daily";
  const sanitizedUrl = sanitizeUrl(payload.pageUrl);
  const symbolHint = payload.symbolHint || guessSymbol(payload.pageTitle, sanitizedUrl || payload.pageUrl) || "unknown";

  const langLine = language === "zh"
    ? "Write the summary field in natural Simplified Chinese, ≤300 characters. Keep schema keys, trend, stage exactly in English."
    : "Write the summary field in English, ≤300 characters. Keep schema keys exactly in English.";

  return [
    formatSection("ROLE", [config.role]),
    formatSection("OBJECTIVE", [config.objective]),
    formatSection("CHART_CONTEXT", [
      `Timeframe of this screenshot: ${tf}.`,
      `Page title: ${payload.pageTitle || "Unknown"}`,
      `Page URL: ${sanitizedUrl || "Unknown"}`,
      `Symbol hint: ${symbolHint}.`
    ]),
    formatBulletSection("CHART_FOCUS", config.chartFocusAreas),
    formatBulletSection("RULES", config.rules),
    formatBulletSection("LANGUAGE_OUTPUT", [langLine]),
    formatSection("OUTPUT_FORMAT", [
      "Return strict JSON only.",
      `Required fields: ${config.requiredFields}`
    ])
  ].join("\n\n");
}

// One-shot LLM call: read a daily/weekly chart screenshot and return a structured summary.
// Output is stored on the monitoringProfile and injected into every subsequent 5-min round
// via formatLongTermContextSection. NOT a trade signal — see prompt-config rules.
export async function generateLongTermContext(payload) {
  const settings = await getSettings();
  const language = getLanguage(settings.language);

  if (!settings.openaiApiKey) {
    throw new Error("Add your OpenAI API key in the popup before generating long-term context.");
  }

  const timeframe = payload.timeframe === "weekly" ? "weekly" : "daily";
  const config = getLongTermPromptConfig();
  const prompt = buildLongTermPrompt(config, { ...payload, timeframe }, language);
  const userContent = [
    { type: "input_text", text: prompt },
    { type: "input_image", image_url: payload.imageDataUrl, detail: "high" }
  ];

  const rawText = await callOpenAi({
    apiKey: settings.openaiApiKey,
    model: settings.model || "gpt-5.4",
    userContent,
    schemaName: "stock_chart_long_term_context",
    schema: LONG_TERM_JSON_SCHEMA,
    maxOutputTokens: LONG_TERM_MAX_OUTPUT_TOKENS
  });

  const parsed = parseJsonResponse(rawText, "Long-term context");
  // Truncate summary defensively even though prompt says ≤300 — prevents pathological growth.
  const summary = (parsed.summary || "").trim().slice(0, LONG_TERM_CONTEXT_MAX_SUMMARY);
  return {
    timeframe,
    summary,
    trend: parsed.trend || "unclear",
    stage: parsed.stage || "unclear",
    keySupport: (parsed.keySupport || "").trim(),
    keyResistance: (parsed.keyResistance || "").trim(),
    symbol: parsed.symbol || payload.symbolHint || null,
    generatedAt: new Date().toISOString()
  };
}

export {
  ALLOWED_ACTIONS,
  ENTRY_MODE_ACTIONS,
  EXIT_MODE_ACTIONS,
  FORCE_EXIT_ACTIONS,
  buildAnalysisPromptFromConfig,
  getAllowedActions
};
