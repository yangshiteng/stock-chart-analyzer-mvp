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
    whatToDoNow: {
      type: "string"
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
    supportLevels: {
      type: "string"
    },
    resistanceLevels: {
      type: "string"
    },
    symbol: {
      anyOf: [{ type: "string" }, { type: "null" }]
    },
    currentPrice: {
      type: "string"
    },
    buyOrderGuidance: {
      type: "object",
      additionalProperties: false,
      properties: {
        price: {
          type: "string"
        },
        shares: {
          type: "string"
        },
        reason: {
          type: "string"
        }
      },
      required: ["price", "shares", "reason"]
    },
    sellOrderGuidance: {
      type: "object",
      additionalProperties: false,
      properties: {
        price: {
          type: "string"
        },
        shares: {
          type: "string"
        },
        reason: {
          type: "string"
        }
      },
      required: ["price", "shares", "reason"]
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
    "whatToDoNow",
    "summary",
    "levels",
    "riskNote",
    "supportLevels",
    "resistanceLevels",
    "symbol",
    "currentPrice",
    "buyOrderGuidance",
    "sellOrderGuidance",
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

function createOrderGuidance(price, shares, reason) {
  return {
    price,
    shares,
    reason
  };
}

function normalizeOrderGuidance(guidance, fallbackGuidance) {
  if (!guidance || typeof guidance !== "object") {
    return fallbackGuidance;
  }

  return {
    price: guidance.price === null || guidance.price === undefined || guidance.price === "" ? fallbackGuidance.price : `${guidance.price}`,
    shares: guidance.shares === null || guidance.shares === undefined || guidance.shares === "" ? fallbackGuidance.shares : `${guidance.shares}`,
    reason: guidance.reason === null || guidance.reason === undefined || guidance.reason === "" ? fallbackGuidance.reason : `${guidance.reason}`
  };
}

function extractNumericPrices(value) {
  if (value === null || value === undefined) {
    return [];
  }

  const matches = `${value}`.match(/\d+(?:\.\d+)?/g) || [];
  return matches
    .map((match) => Number.parseFloat(match))
    .filter((number) => Number.isFinite(number));
}

function getCurrentPriceNumber(analysis) {
  return extractNumericPrices(analysis.currentPrice)[0] ?? null;
}

function getOrderRiskStyle(payload, side) {
  const value = side === "buy"
    ? `${payload.rules?.buyRiskStyle || "conservative"}`.trim()
    : `${payload.rules?.sellRiskStyle || "conservative"}`.trim();

  if (value === "aggressive" || value === "moderate" || value === "conservative") {
    return value;
  }

  return "conservative";
}

function formatReferencePrice(value) {
  return Number(value).toFixed(2);
}

function getOffsetReferencePrice(side, currentPrice) {
  if (!Number.isFinite(currentPrice)) {
    return "N/A";
  }

  const offset = Math.max(currentPrice * 0.01, 0.01);
  const adjusted = side === "buy"
    ? Math.max(currentPrice - offset, 0.01)
    : currentPrice + offset;

  return formatReferencePrice(adjusted);
}

function pickPriceByRiskStyle(side, prices, riskStyle) {
  if (prices.length === 0) {
    return null;
  }

  const sorted = [...new Set(prices)].sort((a, b) => a - b);

  if (side === "buy") {
    if (riskStyle === "aggressive") {
      return sorted[sorted.length - 1];
    }

    if (riskStyle === "moderate") {
      return sorted[Math.floor((sorted.length - 1) / 2)];
    }

    return sorted[0];
  }

  if (riskStyle === "aggressive") {
    return sorted[sorted.length - 1];
  }

  if (riskStyle === "moderate") {
    return sorted[Math.floor((sorted.length - 1) / 2)];
  }

  return sorted[0];
}

function pickRelativeReferencePrice(side, currentPrice, candidates, riskStyle = "conservative") {
  if (!Number.isFinite(currentPrice)) {
    return candidates.find((candidate) => candidate && candidate !== "N/A") || "N/A";
  }

  const compare = side === "buy"
    ? (value) => value < currentPrice
    : (value) => value > currentPrice;
  const allValidPrices = [];

  for (const candidate of candidates) {
    if (!candidate || candidate === "N/A") {
      continue;
    }

    const prices = extractNumericPrices(candidate);

    if (prices.length === 0) {
      continue;
    }

    const validPrices = prices.filter(compare);

    if (validPrices.length > 0) {
      allValidPrices.push(...validPrices);
    }
  }

  const selected = pickPriceByRiskStyle(side, allValidPrices, riskStyle);

  if (selected !== null) {
    return formatReferencePrice(selected);
  }

  return getOffsetReferencePrice(side, currentPrice);
}

function isGuidancePriceDirectionValid(side, price, currentPrice) {
  if (!Number.isFinite(currentPrice)) {
    return true;
  }

  const prices = extractNumericPrices(price);

  if (prices.length === 0) {
    return false;
  }

  return side === "buy"
    ? prices.every((value) => value < currentPrice)
    : prices.every((value) => value > currentPrice);
}

function getAllowedActions(payload) {
  const currentShares = Number(payload.positionContext?.currentShares ?? 0);
  const availableCash = Number(payload.capitalContext?.availableCash ?? 0);
  const allowSellSideActions = Boolean(payload.rules?.allowSellSideActions);
  const canAddCapital = availableCash > 0;
  const actions = new Set(["WAIT"]);

  if (currentShares > 0) {
    actions.add("HOLD");

    if (allowSellSideActions) {
      actions.add("REDUCE");
      actions.add("EXIT");
    }

    if (canAddCapital) {
      actions.add("ADD");
    }
  } else if (canAddCapital) {
    actions.add("OPEN");
  }

  return Array.from(actions);
}

function getFallbackText(language, key, value = "") {
  const dict = {
    noSizeChange: language === "zh" ? "当前不调整仓位。" : "No size change.",
    noNewPosition: language === "zh" ? "当前不建立新仓。" : "No new position.",
    keepCurrentPosition: language === "zh"
      ? "先保持当前仓位不变。不要执行违反当前规则的订单。"
      : "Keep the current position unchanged for now. Do not place an order that violates your current rules.",
    noNewOrderNow: language === "zh"
      ? "现在不要下新的单子。刚才建议的动作不符合你当前的执行规则。"
      : "Do not place a new order right now. The suggested action would violate your current rules.",
    invalidActionSummary: language === "zh"
      ? `模型原本返回了 ${value}，但这个动作不符合你当前的执行规则。`
      : `The model initially returned ${value}, but that action is not allowed under your current execution rules.`,
    holdOnlyRisk: language === "zh"
      ? "如果你以后希望助手考虑卖出类动作，请显式打开这个规则。在此之前，应把当前情形视为只允许持有。"
      : "If you want the assistant to consider sell-side actions later, turn that rule on explicitly. Until then, treat this as a hold-only setup.",
    loosenBuyingRules: language === "zh"
      ? "如果你以后希望助手考虑新的入场动作，请先放宽当前的买入限制。"
      : "If you want the assistant to consider entry actions later, loosen the current buying constraints first.",
    smallStarterSize: language === "zh" ? "小仓试单" : "Small starter size",
    positionDependent: language === "zh" ? "视持仓而定" : "Position-dependent",
    noCashBuyReason: language === "zh"
      ? "当前没有可用资金。这一档仅作为限价买入参考位，不建议立即挂单。"
      : "No available cash right now. Treat this as a reference limit buy level rather than an active order.",
    patientBuyReason: language === "zh"
      ? "优先在可见支撑附近耐心挂限价买单，不要追逐当前已经拉升的价格。"
      : "Use a patient limit buy near visible support instead of chasing the current move.",
    sellDisabledReason: language === "zh"
      ? "你当前禁用了卖出类动作。这一档仅作为限价卖出参考位，不作为立即执行的卖单建议。"
      : "Sell-side actions are disabled in your current rules. Treat this as a reference sell level only.",
    sellNearResistance: language === "zh"
      ? "优先把限价卖单放在可见阻力位或下一段上行目标附近。"
      : "Use a limit sell near visible resistance or the next upside objective.",
    sellAfterOpen: language === "zh"
      ? "把这一档当作未来开仓后的止盈参考卖点。"
      : "Use this as a reference limit sell level for future profit-taking after a position is opened."
  };

  return dict[key];
}

function coerceDisallowedAction(analysis, payload, language = "en") {
  const allowedActions = new Set(getAllowedActions(payload));

  if (allowedActions.has(analysis.action)) {
    return analysis;
  }

  const hasPosition = Number(payload.positionContext?.currentShares ?? 0) > 0;

  return {
    ...analysis,
    action: hasPosition ? "HOLD" : "WAIT",
    orderType: "NONE",
    limitPrice: "N/A",
    sizeSuggestion: hasPosition ? getFallbackText(language, "noSizeChange") : getFallbackText(language, "noNewPosition"),
    whatToDoNow: hasPosition
      ? getFallbackText(language, "keepCurrentPosition")
      : getFallbackText(language, "noNewOrderNow"),
    summary: getFallbackText(language, "invalidActionSummary", analysis.action),
    riskNote: hasPosition
      ? getFallbackText(language, "holdOnlyRisk")
      : getFallbackText(language, "loosenBuyingRules"),
    currentPrice: analysis.currentPrice || "N/A"
  };
}

function buildFallbackBuyGuidance(analysis, payload, language = "en") {
  const hasBuyCapital = Number(payload.capitalContext?.availableCash ?? 0) > 0;
  const currentPrice = getCurrentPriceNumber(analysis);
  const riskStyle = getOrderRiskStyle(payload, "buy");
  const entry = pickRelativeReferencePrice("buy", currentPrice, [
    analysis.supportLevels,
    analysis.levels?.entry,
    analysis.limitPrice,
    analysis.currentPrice
  ], riskStyle);
  const shares = analysis.sizeSuggestion || (hasBuyCapital ? getFallbackText(language, "smallStarterSize") : "N/A");

  if (!hasBuyCapital) {
    return createOrderGuidance(
      entry,
      "N/A",
      getFallbackText(language, "noCashBuyReason")
    );
  }

  return createOrderGuidance(
    entry,
    shares,
    getFallbackText(language, "patientBuyReason")
  );
}

function buildFallbackSellGuidance(analysis, payload, language = "en") {
  const sellSideAllowed = Boolean(payload.rules?.allowSellSideActions);
  const currentShares = Number(payload.positionContext?.currentShares ?? 0);
  const currentPrice = getCurrentPriceNumber(analysis);
  const riskStyle = getOrderRiskStyle(payload, "sell");
  const price = pickRelativeReferencePrice("sell", currentPrice, [
    analysis.resistanceLevels,
    analysis.levels?.target,
    analysis.currentPrice
  ], riskStyle);
  const shares = currentShares > 0 ? `${currentShares}` : getFallbackText(language, "positionDependent");

  if (!sellSideAllowed) {
    return createOrderGuidance(
      price,
      shares,
      getFallbackText(language, "sellDisabledReason")
    );
  }

  return createOrderGuidance(
    price,
    shares,
    currentShares > 0
      ? getFallbackText(language, "sellNearResistance")
      : getFallbackText(language, "sellAfterOpen")
  );
}

function coerceOrderGuidance(analysis, payload, language = "en") {
  const hasBuyCapital = Number(payload.capitalContext?.availableCash ?? 0) > 0;
  const sellSideAllowed = Boolean(payload.rules?.allowSellSideActions);
  const currentPrice = getCurrentPriceNumber(analysis);
  const buyRiskStyle = getOrderRiskStyle(payload, "buy");
  const sellRiskStyle = getOrderRiskStyle(payload, "sell");
  const fallbackBuyGuidance = buildFallbackBuyGuidance(analysis, payload, language);
  const fallbackSellGuidance = buildFallbackSellGuidance(analysis, payload, language);
  let buyOrderGuidance = normalizeOrderGuidance(analysis.buyOrderGuidance, fallbackBuyGuidance);
  let sellOrderGuidance = normalizeOrderGuidance(analysis.sellOrderGuidance, fallbackSellGuidance);

  const preferredBuyReference = pickRelativeReferencePrice("buy", currentPrice, [
    analysis.supportLevels,
    analysis.levels?.entry,
    analysis.limitPrice,
    buyOrderGuidance.price
  ], buyRiskStyle);
  const preferredSellReference = pickRelativeReferencePrice("sell", currentPrice, [
    analysis.resistanceLevels,
    analysis.levels?.target,
    sellOrderGuidance.price
  ], sellRiskStyle);

  if (!isGuidancePriceDirectionValid("buy", buyOrderGuidance.price, currentPrice)) {
    buyOrderGuidance = fallbackBuyGuidance;
  }

  if (!isGuidancePriceDirectionValid("sell", sellOrderGuidance.price, currentPrice)) {
    sellOrderGuidance = fallbackSellGuidance;
  }

  if (preferredBuyReference !== "N/A") {
    buyOrderGuidance = {
      ...buyOrderGuidance,
      price: preferredBuyReference
    };
  }

  if (preferredSellReference !== "N/A") {
    sellOrderGuidance = {
      ...sellOrderGuidance,
      price: preferredSellReference
    };
  }

  if (!hasBuyCapital) {
    buyOrderGuidance = fallbackBuyGuidance;
  }

  if (!sellSideAllowed) {
    sellOrderGuidance = fallbackSellGuidance;
  }

  return {
    ...analysis,
    buyOrderGuidance,
    sellOrderGuidance
  };
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
    `Averaging down allowed: ${formatBoolean(payload.rules?.allowAveragingDown)}.`,
    `Sell-side actions allowed: ${formatBoolean(payload.rules?.allowSellSideActions)}.`,
    `Selected buy risk style: ${formatPromptValue(payload.rules?.buyRiskStyle)}.`,
    `Selected sell risk style: ${formatPromptValue(payload.rules?.sellRiskStyle)}.`,
    "Use EMA 20/50/100/200 only if they are visible in the screenshot. Do not invent EMA relationships.",
    "If the best action is OPEN, ADD, REDUCE, or EXIT, use a LIMIT order and provide a practical limit price.",
    "If the best action is HOLD or WAIT, use orderType NONE and set limitPrice to N/A.",
    "If sell-side actions are not allowed, never return REDUCE or EXIT. Choose HOLD or WAIT instead and explain the risk in summary and riskNote.",
    "Set currentPrice to the current visible price shown on the chart if it can be read reliably. If it is not readable from the screenshot, use N/A.",
    "Hard rule: when currentPrice is readable, buyOrderGuidance.price must be below currentPrice.",
    "Hard rule: when currentPrice is readable, sellOrderGuidance.price must be above currentPrice.",
    "Do not suggest a buy reference above the current price.",
    "Do not suggest a sell reference below the current price.",
    "Always return supportLevels and resistanceLevels as short visible price references from the chart.",
    "Base buyOrderGuidance mainly on visible support levels or pullback areas.",
    "Base sellOrderGuidance mainly on visible resistance levels or upside target areas.",
    "Use the selected buy risk style to place the buy reference.",
    "If buy risk style is conservative, place the buy reference near the lowest visible support below the current price.",
    "If buy risk style is aggressive, place the buy reference near the highest visible support below the current price.",
    "If buy risk style is moderate, prefer a middle support level below the current price when multiple supports are visible.",
    "Use the selected sell risk style to place the sell reference.",
    "If sell risk style is conservative, place the sell reference near the nearest visible resistance above the current price.",
    "If sell risk style is aggressive, place the sell reference near the highest visible resistance above the current price.",
    "If sell risk style is moderate, prefer a middle resistance level above the current price when multiple resistances are visible.",
    "Assume the user may be a beginner.",
    "Use plain everyday language in whatToDoNow, summary, riskNote, and the buy/sell guidance reasons.",
    "Avoid jargon like breakout, pullback, resistance, support, momentum, invalidation, and EMA stack unless it truly helps.",
    "If you mention a technical term, explain it in simple words immediately.",
    "Prefer short sentences with one idea at a time.",
    "Always return buyOrderGuidance and sellOrderGuidance.",
    "Use buyOrderGuidance and sellOrderGuidance as fresh suggested limit-order reference ideas.",
    "Each guidance object must include only price, shares, and reason.",
    "Even when the immediate action is HOLD or WAIT, still provide one practical or conservative limit buy reference and one practical or conservative limit sell reference whenever the chart structure allows it.",
    "When a side is constrained, still provide a reference level and explain that it is not an immediate execution recommendation.",
    "Use buyOrderGuidance.reason and sellOrderGuidance.reason for concise limit-order explanations.",
    "Set whatToDoNow to one clear natural-language instruction that directly tells the user what to do now.",
    "Do not stuff long multi-clause technical commentary into whatToDoNow. Use summary and riskNote for the fuller explanation.",
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
    "Use plain, everyday Simplified Chinese for beginner stock users.",
    "Avoid professional jargon when possible.",
    "If a technical term such as EMA, support, resistance, breakout, or pullback must appear, explain it in simple words right away.",
    "Prefer short, direct sentences.",
    "Keep schema keys unchanged.",
    "Keep action and orderType exactly as they are.",
    "Keep ticker symbols and timeframe values unchanged unless they are explanatory text.",
    "Keep currentPrice unchanged when it is a raw price. Only translate it if it contains explanatory text.",
    "Keep buyOrderGuidance.price, buyOrderGuidance.shares, sellOrderGuidance.price, and sellOrderGuidance.shares unchanged when they are raw values.",
    "Translate limitPrice only when it contains explanatory text rather than a raw price.",
    "Translate whatToDoNow, sizeSuggestion, summary, levels.entry, levels.target, levels.invalidation, supportLevels, resistanceLevels, riskNote, buyOrderGuidance.reason, and sellOrderGuidance.reason into natural Simplified Chinese.",
    "Return strict JSON only.",
    JSON.stringify(analysis)
  ].join("\n");

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
  const analysis = coerceOrderGuidance(
    coerceDisallowedAction(parseJsonResponse(rawText, "Analysis"), payload, language),
    payload,
    language
  );

  if (language === "zh") {
    const translatedAnalysis = await translateAnalysisToChinese(analysis, settings);

    return coerceOrderGuidance(
      coerceDisallowedAction(translatedAnalysis, payload, language),
      payload,
      language
    );
  }

  return analysis;
}

export {
  buildAnalysisPromptFromConfig
};
