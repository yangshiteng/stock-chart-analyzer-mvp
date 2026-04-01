import { getAnalysisPromptConfig } from "./prompt-config.js";
import { getLanguage } from "./i18n.js";
import { getSettings } from "./storage.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["OPEN", "ADD", "HOLD", "REDUCE", "EXIT", "WAIT"]
    },
    orderType: {
      type: "string",
      enum: ["LIMIT", "NONE"]
    },
    limitPrice: {
      type: "string"
    },
    sizeSuggestion: {
      type: "string"
    },
    confidence: {
      type: "number"
    },
    summary: {
      type: "string"
    },
    levels: {
      type: "object",
      additionalProperties: false,
      properties: {
        entry: { type: "string" },
        target: { type: "string" },
        invalidation: { type: "string" }
      },
      required: ["entry", "target", "invalidation"]
    },
    riskNote: {
      type: "string"
    },
    symbol: {
      anyOf: [{ type: "string" }, { type: "null" }]
    },
    timeframe: {
      type: "string"
    }
  },
  required: [
    "action",
    "orderType",
    "limitPrice",
    "sizeSuggestion",
    "confidence",
    "summary",
    "levels",
    "riskNote",
    "symbol",
    "timeframe"
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

function formatPromptValue(value) {
  return value === null || value === undefined || value === "" ? "not provided" : `${value}`;
}

function formatBoolean(value) {
  return value ? "yes" : "no";
}

function guessSymbol(pageTitle, pageUrl) {
  const match = `${pageTitle || ""} ${pageUrl || ""}`.match(/\b[A-Z]{1,5}\b/);
  return match ? match[0] : null;
}

function buildPositionSummary(positionContext) {
  const currentShares = Number(positionContext?.currentShares ?? 0);
  const averageCost = positionContext?.averageCost;

  if (currentShares > 0 && averageCost !== null && averageCost !== undefined) {
    return `currently holding ${currentShares} shares at an average cost of ${averageCost}`;
  }

  if (currentShares > 0) {
    return `currently holding ${currentShares} shares`;
  }

  return "currently holding no shares";
}

function getAllowedActions(payload) {
  const currentShares = Number(payload.positionContext?.currentShares ?? 0);
  const availableCash = Number(payload.capitalContext?.availableCash ?? 0);
  const maxNewCapital = Number(payload.capitalContext?.maxNewCapital ?? 0);
  const allowReducingPosition = Boolean(payload.rules?.allowReducingPosition);
  const canAddCapital = availableCash > 0 && maxNewCapital > 0;
  const actions = new Set(["WAIT"]);

  if (currentShares > 0) {
    actions.add("HOLD");
    actions.add("EXIT");

    if (allowReducingPosition) {
      actions.add("REDUCE");
    }

    if (canAddCapital) {
      actions.add("ADD");
    }
  } else if (canAddCapital) {
    actions.add("OPEN");
  }

  return Array.from(actions);
}

function buildAnalysisPromptFromConfig(config, payload) {
  const allowedActions = getAllowedActions(payload);

  return [
    config.systemRole,
    config.task,
    "Assume the user has already chosen this stock through separate fundamental analysis.",
    `Focus areas: ${formatList(config.focusAreas)}.`,
    `Avoid patterns: ${formatList(config.avoidPatterns)}.`,
    `Risk style rule: ${config.riskStyle}.`,
    `Confidence policy: ${config.confidencePolicy}`,
    `No-trade policy: ${config.noTradePolicy}`,
    `Response style: ${config.responseStyle}`,
    `Allowed actions for this user right now: ${formatList(allowedActions)}.`,
    `Current shares held: ${formatPromptValue(payload.positionContext?.currentShares)}.`,
    `Average cost basis: ${formatPromptValue(payload.positionContext?.averageCost)}.`,
    `Available cash: ${formatPromptValue(payload.capitalContext?.availableCash)}.`,
    `Max new capital for this trade: ${formatPromptValue(payload.capitalContext?.maxNewCapital)}.`,
    `Averaging down allowed: ${formatBoolean(payload.rules?.allowAveragingDown)}.`,
    `Reducing position allowed: ${formatBoolean(payload.rules?.allowReducingPosition)}.`,
    `Selected risk style: ${formatPromptValue(payload.rules?.riskStyle)}.`,
    "Use EMA 20/50/100/200 only if they are visible in the screenshot. Do not invent EMA relationships.",
    "If the best action is OPEN, ADD, REDUCE, or EXIT, use a LIMIT order and provide a practical limit price.",
    "If the best action is HOLD or WAIT, use orderType NONE and set limitPrice to N/A.",
    "Return strict JSON only.",
    `Required fields: ${config.requiredFields}`,
    `Page title: ${payload.pageTitle || "Unknown"}`,
    `Page URL: ${payload.pageUrl || "Unknown"}`
  ].join("\n");
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
      max_output_tokens: 700,
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
                "Keep schema keys, action, and orderType exactly in English as required.",
                `Symbol guess from page text: ${guessSymbol(payload.pageTitle, payload.pageUrl) || "unknown"}.`,
                `Position summary: ${buildPositionSummary(payload.positionContext)}.`
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
    "Translate the user-facing text in this stock chart execution analysis JSON into Simplified Chinese.",
    "Keep schema keys unchanged.",
    "Keep action and orderType exactly as they are.",
    "Keep ticker symbols and timeframe values unchanged unless they are explanatory text.",
    "Translate limitPrice only when it contains explanatory text rather than a raw price.",
    "Translate sizeSuggestion, summary, levels.entry, levels.target, levels.invalidation, and riskNote into natural Simplified Chinese.",
    "Return strict JSON only.",
    JSON.stringify(analysis)
  ].join("\n");

  const translatedText = await callOpenAiJson({
    apiKey: settings.openaiApiKey,
    model: settings.model || "gpt-5.4",
    inputText: translationPrompt,
    schemaName: "stock_chart_execution_analysis_zh",
    schema: ANALYSIS_JSON_SCHEMA,
    maxOutputTokens: 700
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
  const analysis = parseJsonResponse(rawText, "Analysis");

  if (language === "zh") {
    return translateAnalysisToChinese(analysis, settings);
  }

  return analysis;
}

export {
  buildAnalysisPromptFromConfig
};
