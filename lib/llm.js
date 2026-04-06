import { getAnalysisPromptConfig } from "./prompt-config.js";
import { getLanguage } from "./i18n.js";
import { getSettings } from "./storage.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ANALYSIS_MAX_OUTPUT_TOKENS = 1100;
const TRANSLATION_MAX_OUTPUT_TOKENS = 1100;
const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["OPEN", "ADD_STRENGTH", "ADD_WEAKNESS", "HOLD", "REDUCE_PROFIT", "REDUCE_RISK", "EXIT", "WAIT"]
    },
    sizeSuggestion: {
      type: "string"
    },
    whatToDoNow: {
      type: "string"
    },
    levels: {
      type: "object",
      additionalProperties: false,
      properties: {
        invalidation: { type: "string" }
      },
      required: ["invalidation"]
    },
    riskNote: {
      type: "string"
    },
    supportLevels: {
      type: "object",
      additionalProperties: false,
      properties: {
        primary: { type: "string" },
        secondary: { type: "string" }
      },
      required: ["primary", "secondary"]
    },
    resistanceLevels: {
      type: "object",
      additionalProperties: false,
      properties: {
        primary: { type: "string" },
        secondary: { type: "string" }
      },
      required: ["primary", "secondary"]
    },
    symbol: {
      anyOf: [{ type: "string" }, { type: "null" }]
    },
    currentPrice: {
      type: "string"
    }
  },
  required: [
    "action",
    "sizeSuggestion",
    "whatToDoNow",
    "levels",
    "riskNote",
    "supportLevels",
    "resistanceLevels",
    "symbol",
    "currentPrice"
  ]
};

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

function formatPromptValue(value) {
  return value === null || value === undefined || value === "" ? "not provided" : `${value}`;
}

function guessSymbol(pageTitle, pageUrl) {
  const match = `${pageTitle || ""} ${pageUrl || ""}`.match(/\b[A-Z]{1,5}\b/);
  return match ? match[0] : null;
}

function normalizeLevelCluster(levels) {
  if (!levels || typeof levels !== "object" || Array.isArray(levels)) {
    const value = levels === null || levels === undefined || levels === "" ? "N/A" : `${levels}`;
    return {
      primary: value,
      secondary: "N/A"
    };
  }

  return {
    primary: levels.primary === null || levels.primary === undefined || levels.primary === "" ? "N/A" : `${levels.primary}`,
    secondary: levels.secondary === null || levels.secondary === undefined || levels.secondary === "" ? "N/A" : `${levels.secondary}`
  };
}

function normalizeAnalysisShape(analysis) {
  return {
    ...analysis,
    supportLevels: normalizeLevelCluster(analysis.supportLevels),
    resistanceLevels: normalizeLevelCluster(analysis.resistanceLevels)
  };
}

function coerceAnalysisDetails(analysis) {
  return normalizeAnalysisShape(analysis);
}

function getAllowedActions(payload) {
  const currentShares = Number(payload.positionContext?.currentShares ?? 0);
  const availableCash = Number(payload.capitalContext?.availableCash ?? 0);
  const canAddCapital = availableCash > 0;
  const actions = new Set(["WAIT"]);

  if (currentShares > 0) {
    actions.add("HOLD");
    actions.add("REDUCE_PROFIT");
    actions.add("REDUCE_RISK");
    actions.add("EXIT");

    if (canAddCapital) {
      actions.add("ADD_STRENGTH");
      actions.add("ADD_WEAKNESS");
    }
  } else if (canAddCapital) {
    actions.add("OPEN");
  }

  return Array.from(actions);
}

function buildAnalysisPromptFromConfig(config, payload) {
  const allowedActions = getAllowedActions(payload);

  return [
    formatSection("ROLE", [config.role]),
    formatSection("OBJECTIVE", [config.objective]),
    formatSection("USER_CONTEXT", [
      `Current shares held: ${formatPromptValue(payload.positionContext?.currentShares)}.`,
      `Average cost basis: ${formatPromptValue(payload.positionContext?.averageCost)}.`,
      `Available cash: ${formatPromptValue(payload.capitalContext?.availableCash)}.`,
      `Selected buy risk style: ${formatPromptValue(payload.rules?.buyRiskStyle)}.`,
      `Selected sell risk style: ${formatPromptValue(payload.rules?.sellRiskStyle)}.`,
      `Allowed actions for this user right now: ${formatList(allowedActions)}.`
    ]),
    formatSection("CHART_CONTEXT", [
      `Page title: ${payload.pageTitle || "Unknown"}`,
      `Page URL: ${payload.pageUrl || "Unknown"}`,
      "Use EMA 20/50/100/200 only if they are visible in the screenshot. Do not invent EMA relationships."
    ]),
    formatBulletSection("CHART_FOCUS", config.chartFocusAreas),
    formatBulletSection("CHART_GUARDRAILS", config.chartGuardrails),
    formatSection("RISK_STYLE_RULE", [config.riskStyleRule]),
    formatBulletSection("ACTION_RULES", config.actionRules),
    formatBulletSection("OUTPUT_RULES", config.outputRules),
    formatBulletSection("LANGUAGE_RULES", config.languageRules),
    formatSection("OUTPUT_FORMAT", [
      "Return strict JSON only.",
      `Required fields: ${config.requiredFields}`
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

async function callOpenAiJson({ apiKey, model, inputText, schemaName, schema, maxOutputTokens = 600 }) {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      reasoning: {
        effort: "low"
      },
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
          content: [
            {
              type: "input_text",
              text: inputText
            }
          ]
        }
      ]
    })
  });

  const rawBody = await response.text();
  let responseData;

  try {
    responseData = JSON.parse(rawBody);
  } catch (error) {
    throw new Error(`OpenAI returned non-JSON HTTP content: ${error.message}`);
  }

  if (!response.ok) {
    const message = responseData.error?.message || `HTTP ${response.status}`;
    throw new Error(`OpenAI request failed: ${message}`);
  }

  if (responseData.status === "incomplete") {
    const reason = responseData.incomplete_details?.reason || "unknown_reason";
    throw new Error(`OpenAI response was incomplete: ${reason}. Try again or reduce prompt/image size.`);
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

async function callOpenAiAnalysis({ prompt, payload, settings }) {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.openaiApiKey}`
    },
    body: JSON.stringify({
      model: settings.model || "gpt-5.4",
      reasoning: {
        effort: "low"
      },
      max_output_tokens: ANALYSIS_MAX_OUTPUT_TOKENS,
      text: {
        format: {
          type: "json_schema",
          name: "stock_chart_execution_analysis",
          strict: true,
          schema: ANALYSIS_JSON_SCHEMA
        }
      },
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
                text: [
                  prompt,
                  "Return all user-facing string values in English.",
                  "Keep schema keys and action exactly in English as required.",
                  `Symbol guess from page text: ${guessSymbol(payload.pageTitle, payload.pageUrl) || "unknown"}.`
                ].join("\n")
              },
            {
              type: "input_image",
              image_url: payload.imageDataUrl,
              detail: "high"
            }
          ]
        }
      ]
    })
  });

  const rawBody = await response.text();
  let responseData;

  try {
    responseData = JSON.parse(rawBody);
  } catch (error) {
    throw new Error(`OpenAI returned non-JSON HTTP content: ${error.message}`);
  }

  if (!response.ok) {
    const message = responseData.error?.message || `HTTP ${response.status}`;
    throw new Error(`OpenAI request failed: ${message}`);
  }

  if (responseData.status === "incomplete") {
    const reason = responseData.incomplete_details?.reason || "unknown_reason";
    throw new Error(`OpenAI response was incomplete: ${reason}. Try again or reduce prompt/image size.`);
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

async function translateAnalysisToChinese(analysis, settings) {
  const translationPrompt = [
    formatSection("ROLE", [
      "You are translating a stock chart execution analysis JSON into Simplified Chinese."
    ]),
    formatSection("GOAL", [
      "Translate only the user-facing text. Do not re-analyze the chart or change the strategy."
    ]),
    formatBulletSection("KEEP_UNCHANGED", [
      "Keep schema keys unchanged.",
      "Keep action exactly as it is.",
      "Keep ticker symbols unchanged unless they are explanatory text.",
      "Keep currentPrice unchanged when it is a raw price. Only translate it if it contains explanatory text.",
      "Keep supportLevels.primary, supportLevels.secondary, resistanceLevels.primary, and resistanceLevels.secondary unchanged when they are raw prices or price zones."
    ]),
    formatBulletSection("TRANSLATE_FIELDS", [
      "Translate whatToDoNow into natural Simplified Chinese.",
      "Translate sizeSuggestion into natural Simplified Chinese.",
      "Translate levels.invalidation into natural Simplified Chinese.",
      "Translate riskNote into natural Simplified Chinese."
    ]),
    formatBulletSection("LANGUAGE_RULES", [
      "Write for beginner stock users.",
      "Use plain, everyday Simplified Chinese.",
      "Keep sentences short and direct.",
      "If a technical term must appear, explain it in simple words right away."
    ]),
    formatSection("OUTPUT_FORMAT", [
      "Return strict JSON only."
    ]),
    formatSection("INPUT_JSON", [
      JSON.stringify(analysis)
    ])
  ].join("\n\n");

  const translatedText = await callOpenAiJson({
    apiKey: settings.openaiApiKey,
    model: settings.model || "gpt-5.4",
    inputText: translationPrompt,
    schemaName: "stock_chart_execution_analysis_zh",
    schema: ANALYSIS_JSON_SCHEMA,
    maxOutputTokens: TRANSLATION_MAX_OUTPUT_TOKENS
  });

  return parseJsonResponse(translatedText, "Translated analysis");
}

export async function analyzeChartCapture(payload) {
  const settings = await getSettings();
  const language = getLanguage(settings.language);

  if (!settings.openaiApiKey) {
    throw new Error("Add your OpenAI API key in the popup before starting monitoring.");
  }

  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), payload);
  const rawText = await callOpenAiAnalysis({
    prompt,
    payload,
    settings
  });
  const englishAnalysis = coerceAnalysisDetails(parseJsonResponse(rawText, "Analysis"));

  if (language === "zh") {
    const translatedAnalysis = await translateAnalysisToChinese(englishAnalysis, settings);

    return coerceAnalysisDetails(translatedAnalysis);
  }

  return englishAnalysis;
}

export {
  buildAnalysisPromptFromConfig
};

