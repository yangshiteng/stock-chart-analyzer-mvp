import { getAnalysisPromptConfig } from "./prompt-config.js";
import { getLanguage } from "./i18n.js";
import { getSettings } from "./storage.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: {
      type: "string",
      enum: ["buy", "sell"]
    },
    signal: {
      type: "string",
      enum: ["BUY", "SELL", "WAIT_FOR_CONFIRMATION", "NO_TRADE"]
    },
    orderType: {
      type: "string",
      enum: ["LIMIT"]
    },
    limitPrice: {
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
      anyOf: [
        { type: "string" },
        { type: "null" }
      ]
    },
    timeframe: {
      type: "string"
    }
  },
  required: [
    "mode",
    "signal",
    "orderType",
    "limitPrice",
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

function buildAnalysisPromptFromConfig(config, { pageTitle, pageUrl, intent, positionContext }) {
  return [
    config.systemRole,
    config.task,
    `Focus areas: ${formatList(config.focusAreas)}.`,
    `Avoid patterns: ${formatList(config.avoidPatterns)}.`,
    `Risk style: ${config.riskStyle}.`,
    `Confidence policy: ${config.confidencePolicy}`,
    `No-trade policy: ${config.noTradePolicy}`,
    `Response style: ${config.responseStyle}`,
    `Allowed signals: ${formatList(config.signalOptions)}.`,
    `User intent: ${formatPromptValue(intent)}.`,
    `Current shares held: ${formatPromptValue(positionContext?.currentShares)}.`,
    `Average cost basis: ${formatPromptValue(positionContext?.averageCost)}.`,
    "Return strict JSON only.",
    `Required fields: ${config.requiredFields}`,
    `Use "mode": "${config.modeValue}".`,
    `Page title: ${pageTitle || "Unknown"}`,
    `Page URL: ${pageUrl || "Unknown"}`
  ].join("\n");
}

function buildBuyAnalysisPrompt(payload) {
  return buildAnalysisPromptFromConfig(getAnalysisPromptConfig("buy"), payload);
}

function buildSellAnalysisPrompt(payload) {
  return buildAnalysisPromptFromConfig(getAnalysisPromptConfig("sell"), payload);
}

function buildAnalysisPrompt(payload) {
  return buildAnalysisPromptFromConfig(getAnalysisPromptConfig(payload.mode), payload);
}

function guessSymbol(pageTitle, pageUrl) {
  const match = `${pageTitle || ""} ${pageUrl || ""}`.match(/\b[A-Z]{1,5}\b/);
  return match ? match[0] : null;
}

function formatIntentText(intent) {
  return intent ? intent.replaceAll("_", " ") : "general review";
}

function buildPositionSummary(positionContext) {
  const currentShares = positionContext?.currentShares ?? 0;
  const averageCost = positionContext?.averageCost;

  if (currentShares > 0 && averageCost !== null && averageCost !== undefined) {
    return `while holding ${currentShares} shares at an average cost of ${averageCost}`;
  }

  if (currentShares > 0) {
    return `while holding ${currentShares} shares`;
  }

  return "with no current position";
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

async function callOpenAiJson({ apiKey, model, inputText, schemaName, schema, maxOutputTokens = 500 }) {
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
      max_output_tokens: 500,
      text: {
        format: {
          type: "json_schema",
          name: "stock_chart_analysis",
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
                "Keep schema keys, mode, signal, and orderType exactly in English as required.",
                `Symbol guess from page text: ${guessSymbol(payload.pageTitle, payload.pageUrl) || "unknown"}.`,
                `Position context summary: ${formatIntentText(payload.intent)} ${buildPositionSummary(payload.positionContext)}.`
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
    "Translate the user-facing text in this stock chart analysis JSON into Simplified Chinese.",
    "Keep schema keys unchanged.",
    "Keep mode, signal, and orderType exactly as they are.",
    "Keep ticker symbols and timeframe values unchanged unless they are explanatory text.",
    "Translate summary, levels.entry, levels.target, levels.invalidation, and riskNote into natural Simplified Chinese.",
    "Return strict JSON only.",
    JSON.stringify(analysis)
  ].join("\n");

  const translatedText = await callOpenAiJson({
    apiKey: settings.openaiApiKey,
    model: settings.model || "gpt-5.4",
    inputText: translationPrompt,
    schemaName: "stock_chart_analysis_zh",
    schema: ANALYSIS_JSON_SCHEMA,
    maxOutputTokens: 600
  });

  return parseJsonResponse(translatedText, "Translated analysis");
}

export async function analyzeChartCapture(payload) {
  const settings = await getSettings();
  const language = getLanguage(settings.language);

  if (!settings.openaiApiKey) {
    throw new Error("Add your OpenAI API key in the side panel before starting monitoring.");
  }

  const prompt = buildAnalysisPrompt(payload);
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
  buildBuyAnalysisPrompt,
  buildSellAnalysisPrompt
};
