import { getAnalysisPromptConfig } from "./prompt-config.js";
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
    `Virtual long position already open.`,
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
      "Keep action, confidence, and all schema keys exactly in English.",
      "Keep entryPrice, stopLossPrice, targetPrice, currentPrice, and symbol as raw decimal prices or raw tickers — do not translate them."
    ]);
  }

  return formatBulletSection("LANGUAGE_OUTPUT", [
    "Return reasoning in English, ≤80 characters.",
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
    const lesson = l.lesson.trim().replace(/\s+/g, " ").slice(0, 180);
    return `- [${sym} ${pnl}${when ? " " + when : ""}] ${lesson}`;
  });
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

export {
  ALLOWED_ACTIONS,
  ENTRY_MODE_ACTIONS,
  EXIT_MODE_ACTIONS,
  FORCE_EXIT_ACTIONS,
  buildAnalysisPromptFromConfig,
  getAllowedActions
};
