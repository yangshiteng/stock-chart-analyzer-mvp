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

function coerceAnalysisDetails(analysis, payload, language = "en") {
  const normalizedAnalysis = normalizeAnalysisShape(analysis);

  return {
    ...normalizedAnalysis,
    sizeSuggestion: buildRiskAwareSizeSuggestion(normalizedAnalysis, payload, language)
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

  if (typeof value === "object") {
    return Object.values(value).flatMap((entry) => extractNumericPrices(entry));
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

function getBuyReferenceCandidates(analysis, action = "WAIT") {
  const candidates = [
    analysis.supportLevels?.primary,
    analysis.supportLevels?.secondary,
    analysis.levels?.entry,
    analysis.limitPrice,
    analysis.currentPrice
  ];

  if (action === "OPEN" || action === "ADD") {
    // A reclaimed breakout level can act like fresh support for a tighter entry.
    candidates.push(
      analysis.resistanceLevels?.primary,
      analysis.resistanceLevels?.secondary
    );
  }

  return candidates;
}

function getResistanceCandidates(analysis) {
  return [
    analysis.resistanceLevels?.primary,
    analysis.resistanceLevels?.secondary,
    analysis.levels?.target,
    analysis.currentPrice
  ];
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

function pickRelativeReferencePrice(
  side,
  currentPrice,
  candidates,
  riskStyle = "conservative",
  { allowOffsetFallback = false } = {}
) {
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

  return allowOffsetFallback ? getOffsetReferencePrice(side, currentPrice) : "N/A";
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
  const canAddCapital = availableCash > 0;
  const actions = new Set(["WAIT"]);

  if (currentShares > 0) {
    actions.add("HOLD");
    actions.add("REDUCE");
    actions.add("EXIT");

    if (canAddCapital) {
      actions.add("ADD");
    }
  } else if (canAddCapital) {
    actions.add("OPEN");
  }

  return Array.from(actions);
}

function getFallbackText(language, key, value = "") {
  const en = {
    noSizeChange: "No size change.",
    noNewPosition: "No new position.",
    keepCurrentPosition: "Keep the current position unchanged for now. Do not place an order that violates your current rules.",
    noNewOrderNow: "Do not place a new order right now. The suggested action would violate your current rules.",
    invalidActionSummary: `The model initially returned ${value}, but that action is not allowed under your current execution rules.`,
    holdOnlyRisk: "Keep the current position unchanged and wait for a cleaner setup.",
    loosenBuyingRules: "Wait until cash or chart structure makes a new order more realistic.",
    smallStarterSize: "Small starter size",
    positionDependent: "Position-dependent",
    noCashBuyReason: "No available cash right now. Treat this as a reference limit buy level rather than an active order.",
    patientBuyReason: "Use a patient limit buy near visible support instead of chasing the current move.",
    sellNearResistance: "Use a limit sell near visible resistance or the next upside objective.",
    sellAfterOpen: "Use this as a reference limit sell level for future profit-taking after a position is opened.",
    noClearBuyReference: "There is no clear buy reference level right now. Wait for either a cleaner pullback area or a stronger reclaim-and-hold setup.",
    noClearSellReference: "There is no clear sell reference level right now. Wait for a cleaner rebound or target area first.",
    buyReferenceNow: "This buy reference sits near visible support or a reclaimed key area and can help you join strength without chasing too far.",
    buyReferenceLater: "This is only a backup buy reference. Consider it only if price pulls back to this area and settles there.",
    sellReferenceNow: "This sell reference sits near visible resistance and is more practical for a patient limit sell.",
    sellReferenceLater: "This is only a backup sell reference. Consider it only if price rebounds into this area later.",
    riskSizeTight: "Size can be more flexible only if the risk level is close and your cash allows it.",
    riskSizeWide: "Keep size smaller because the risk level is relatively far from the current price.",
    riskSizeUnknown: "Keep size modest because the chart risk level is not clear enough yet."
  };
  const zh = {
    noSizeChange: "当前不调整仓位。",
    noNewPosition: "当前不建立新仓。",
    keepCurrentPosition: "先保持当前仓位不变。不要执行违反当前规则的订单。",
    noNewOrderNow: "现在先不要下新的单子。刚才建议的动作不符合你当前的执行规则。",
    invalidActionSummary: `模型原本返回了 ${value}，但这个动作不符合你当前的执行规则。`,
    holdOnlyRisk: "先保持当前仓位不变，等更清楚的机会出现。",
    loosenBuyingRules: "先等资金条件或图表结构更合适，再考虑新的订单。",
    smallStarterSize: "小仓试单",
    positionDependent: "视持仓而定",
    noCashBuyReason: "当前没有可用资金。这一档仅作为限价买入参考位，不建议立刻挂单。",
    patientBuyReason: "优先在可见支撑附近耐心挂限价买单，不要追已经拉升的价格。",
    sellNearResistance: "优先把限价卖单放在可见压力位或下一段上涨目标附近。",
    sellAfterOpen: "把这一档当作未来开仓后的止盈参考卖点。",
    noClearBuyReference: "现在没有看清楚的买入参考位。先等更清晰的回落区域，或者等更明确的重新站稳信号。",
    noClearSellReference: "现在没有看清楚的卖出参考位。先等更清晰的反弹或目标区域。",
    buyReferenceNow: "这个买入参考位更靠近当前可见支撑，或更靠近刚重新站稳的关键位置，适合用来更主动但不追高地挂限价单。",
    buyReferenceLater: "这只是备用的买入参考位。只有价格回落到这里附近并稳住时再考虑。",
    sellReferenceNow: "这个卖出参考位更靠近当前可见压力，更适合作为耐心的限价卖出参考。",
    sellReferenceLater: "这只是备用的卖出参考位。只有价格之后反弹到这里附近时再考虑。",
    riskSizeTight: "只有在风险位离得比较近、而且资金允许时，仓位才可以更灵活一些。",
    riskSizeWide: "因为风险位离现价还比较远，所以这笔仓位要更小一点。",
    riskSizeUnknown: "因为图上的风险位还不够清楚，所以仓位先保持保守。"
  };

  return (language === "zh" ? zh : en)[key];
}

function getRiskDistanceRatio(analysis) {
  const currentPrice = getCurrentPriceNumber(analysis);
  const invalidation = extractNumericPrices(analysis.levels?.invalidation)[0] ?? null;

  if (!Number.isFinite(currentPrice) || !Number.isFinite(invalidation) || currentPrice <= 0) {
    return null;
  }

  return Math.abs(currentPrice - invalidation) / currentPrice;
}

function formatUsd(value) {
  return `$${Number(value).toFixed(0)}`;
}

function formatPercent(value) {
  return `${Math.max(1, Math.round(value * 100))}%`;
}

function getReferencePriceNumber(value) {
  return extractNumericPrices(value)[0] ?? null;
}

function getDistanceFactor(distanceRatio) {
  if (distanceRatio === null) {
    return 0.65;
  }

  if (distanceRatio <= 0.015) {
    return 1;
  }

  if (distanceRatio <= 0.03) {
    return 0.8;
  }

  if (distanceRatio <= 0.05) {
    return 0.65;
  }

  return 0.5;
}

function getBuyAllocationPercent(riskStyle, action) {
  const table = {
    conservative: { OPEN: 0.14, ADD: 0.1, HOLD: 0.08, WAIT: 0.08 },
    moderate: { OPEN: 0.22, ADD: 0.15, HOLD: 0.1, WAIT: 0.1 },
    aggressive: { OPEN: 0.3, ADD: 0.2, HOLD: 0.12, WAIT: 0.12 }
  };

  return table[riskStyle]?.[action] ?? 0.1;
}

function getSellTrimPercent(riskStyle, action) {
  if (action === "EXIT") {
    return 1;
  }

  const table = {
    conservative: { REDUCE: 0.35, HOLD: 0.3 },
    moderate: { REDUCE: 0.25, HOLD: 0.22 },
    aggressive: { REDUCE: 0.18, HOLD: 0.15 }
  };

  return table[riskStyle]?.[action] ?? 0;
}

function buildConcreteBuyPlan(analysis, payload, language = "en", referencePrice = null) {
  const availableCash = Number(payload.capitalContext?.availableCash ?? 0);
  const action = analysis.action || "WAIT";
  const riskStyle = getOrderRiskStyle(payload, "buy");
  const distanceRatio = getRiskDistanceRatio(analysis);
  const basePrice = Number.isFinite(referencePrice) && referencePrice > 0
    ? referencePrice
    : getCurrentPriceNumber(analysis);

  if (availableCash <= 0 || !Number.isFinite(basePrice) || basePrice <= 0) {
    return {
      shares: "N/A",
      summary: language === "zh"
        ? "当前先不要新增仓位，等更清楚的价格机会。"
        : "Do not add new size yet. Wait for a clearer price opportunity."
    };
  }

  const allocationPercent = Math.min(
    0.45,
    getBuyAllocationPercent(riskStyle, action) * getDistanceFactor(distanceRatio)
  );
  const plannedCash = Math.max(basePrice, availableCash * allocationPercent);
  const shares = Math.max(1, Math.floor(plannedCash / basePrice));
  const usedCash = Math.min(availableCash, shares * basePrice);

  if (!Number.isFinite(shares) || shares <= 0) {
    return {
      shares: "N/A",
      summary: language === "zh"
        ? "当前先不要新增仓位，等更清楚的价格机会。"
        : "Do not add new size yet. Wait for a clearer price opportunity."
    };
  }

  const summary = action === "OPEN" || action === "ADD"
    ? (
      language === "zh"
        ? `先考虑不超过 ${shares} 股，约动用可用资金的 ${formatPercent(usedCash / availableCash)}（约 ${formatUsd(usedCash)}）。`
        : `Start with no more than ${shares} shares, using about ${formatPercent(usedCash / availableCash)} of available cash (about ${formatUsd(usedCash)}).`
    )
    : (
      language === "zh"
        ? `如果之后回落到更好的买入区域，先考虑不超过 ${shares} 股，约动用可用资金的 ${formatPercent(usedCash / availableCash)}（约 ${formatUsd(usedCash)}）。`
        : `If price later falls into a better buying area, consider no more than ${shares} shares, using about ${formatPercent(usedCash / availableCash)} of available cash (about ${formatUsd(usedCash)}).`
    );

  return {
    shares: `${shares}`,
    summary
  };
}

function buildConcreteSellPlan(analysis, payload, language = "en") {
  const currentShares = Number(payload.positionContext?.currentShares ?? 0);
  const action = analysis.action || "WAIT";
  const riskStyle = getOrderRiskStyle(payload, "sell");

  if (currentShares <= 0) {
    return {
      shares: "N/A",
      summary: getFallbackText(language, "noSizeChange")
    };
  }

  if (action === "EXIT") {
    return {
      shares: `${currentShares}`,
      summary: language === "zh"
        ? `如果之后走到退出条件，就按当前仓位全部 ${currentShares} 股来执行。`
        : `If the chart later reaches the exit condition, use the full current position of ${currentShares} shares.`
    };
  }

  const trimPercent = getSellTrimPercent(riskStyle, action);

  if (trimPercent <= 0) {
    return {
      shares: "N/A",
      summary: language === "zh"
        ? `先保持当前 ${currentShares} 股不变。`
        : `Keep the current ${currentShares} shares unchanged for now.`
    };
  }

  const shares = Math.max(1, Math.floor(currentShares * trimPercent));

  return {
    shares: `${shares}`,
    summary: language === "zh"
      ? `如果之后反弹到更合适的卖出区域，可先考虑卖出约 ${shares} 股，约占当前仓位的 ${formatPercent(shares / currentShares)}。`
      : `If price later rebounds into a better selling area, consider selling about ${shares} shares, or roughly ${formatPercent(shares / currentShares)} of the current position.`
  };
}

function buildRiskAwareSizeSuggestion(analysis, payload, language = "en") {
  const currentShares = Number(payload.positionContext?.currentShares ?? 0);
  const action = analysis.action || "WAIT";

  if (action === "OPEN" || action === "ADD") {
    return buildConcreteBuyPlan(analysis, payload, language).summary;
  }

  if (action === "REDUCE" || action === "EXIT") {
    return buildConcreteSellPlan(analysis, payload, language).summary;
  }

  if (action === "HOLD") {
    return currentShares > 0
      ? (
        language === "zh"
          ? `先保持当前 ${currentShares} 股不变，不要急着改仓位。`
          : `Keep the current ${currentShares} shares unchanged for now. Do not rush to resize the position.`
      )
      : getFallbackText(language, "noNewPosition");
  }

  return currentShares > 0
    ? (
      language === "zh"
        ? `先保持当前 ${currentShares} 股不变，等待更清楚的机会。`
        : `Keep the current ${currentShares} shares unchanged and wait for a clearer setup.`
    )
    : getFallbackText(language, "noNewPosition");
}

function getFallbackReferenceShares(side, analysis, payload, language = "en", referencePrice = "N/A") {
  const currentShares = Number(payload.positionContext?.currentShares ?? 0);
  const rawShares = side === "buy" ? analysis.buyOrderGuidance?.shares : analysis.sellOrderGuidance?.shares;
  const numericShares = extractNumericPrices(rawShares)[0] ?? null;

  if (Number.isFinite(numericShares) && numericShares > 0) {
    return `${Math.round(numericShares)}`;
  }

  if (side === "sell") {
    return buildConcreteSellPlan(analysis, payload, language).shares;
  }

  if (side === "buy" && Number(payload.capitalContext?.availableCash ?? 0) > 0) {
    return buildConcreteBuyPlan(
      analysis,
      payload,
      language,
      getReferencePriceNumber(referencePrice)
    ).shares;
  }

  return "N/A";
}

function shouldShowBuyReference(action, payload) {
  const hasBuyCapital = Number(payload.capitalContext?.availableCash ?? 0) > 0;

  if (!hasBuyCapital) {
    return false;
  }

  if (action === "OPEN" || action === "ADD") {
    return true;
  }

  if (action === "HOLD" || action === "WAIT") {
    return true;
  }

  return false;
}

function shouldShowSellReference(action, payload) {
  const hasPosition = Number(payload.positionContext?.currentShares ?? 0) > 0;

  if (!hasPosition) {
    return false;
  }

  return action === "REDUCE" || action === "EXIT" || action === "HOLD";
}

function buildBuyReferenceReason(language, action, hasPosition) {
  if (action === "OPEN" || action === "ADD") {
    return getFallbackText(language, "buyReferenceNow");
  }

  if (action === "HOLD" || action === "WAIT" || hasPosition) {
    return getFallbackText(language, "buyReferenceLater");
  }

  return getFallbackText(language, "patientBuyReason");
}

function buildSellReferenceReason(language, action) {
  if (action === "REDUCE" || action === "EXIT") {
    return getFallbackText(language, "sellReferenceNow");
  }

  return getFallbackText(language, "sellReferenceLater");
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
    sizeSuggestion: hasPosition
      ? getFallbackText(language, "noSizeChange")
      : buildRiskAwareSizeSuggestion(analysis, payload, language),
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
  const hasPosition = Number(payload.positionContext?.currentShares ?? 0) > 0;
  const currentPrice = getCurrentPriceNumber(analysis);
  const riskStyle = getOrderRiskStyle(payload, "buy");
  const action = analysis.action || "WAIT";
  const entry = pickRelativeReferencePrice(
    "buy",
    currentPrice,
    getBuyReferenceCandidates(analysis, action),
    riskStyle,
    { allowOffsetFallback: action === "OPEN" || action === "ADD" }
  );
  const shares = getFallbackReferenceShares("buy", analysis, payload, language, entry);

  if (!hasBuyCapital) {
    return createOrderGuidance("N/A", "N/A", getFallbackText(language, "noCashBuyReason"));
  }

  if (!shouldShowBuyReference(action, payload) || entry === "N/A") {
    return createOrderGuidance("N/A", "N/A", getFallbackText(language, "noClearBuyReference"));
  }

  return createOrderGuidance(entry, shares, buildBuyReferenceReason(language, action, hasPosition));
}

function buildFallbackSellGuidance(analysis, payload, language = "en") {
  const currentShares = Number(payload.positionContext?.currentShares ?? 0);
  const currentPrice = getCurrentPriceNumber(analysis);
  const riskStyle = getOrderRiskStyle(payload, "sell");
  const action = analysis.action || "WAIT";
  const price = pickRelativeReferencePrice(
    "sell",
    currentPrice,
    getResistanceCandidates(analysis),
    riskStyle
  );
  const shares = getFallbackReferenceShares("sell", analysis, payload, language, price);

  if (!shouldShowSellReference(action, payload) || price === "N/A") {
    return createOrderGuidance("N/A", "N/A", getFallbackText(language, "noClearSellReference"));
  }

  return createOrderGuidance(price, shares, buildSellReferenceReason(language, action));
}

function coerceOrderGuidance(analysis, payload, language = "en") {
  const normalizedAnalysis = normalizeAnalysisShape(analysis);
  const hasBuyCapital = Number(payload.capitalContext?.availableCash ?? 0) > 0;
  const shouldKeepBuyReference = shouldShowBuyReference(normalizedAnalysis.action || "WAIT", payload);
  const shouldKeepSellReference = shouldShowSellReference(normalizedAnalysis.action || "WAIT", payload);
  const currentPrice = getCurrentPriceNumber(normalizedAnalysis);
  const buyRiskStyle = getOrderRiskStyle(payload, "buy");
  const sellRiskStyle = getOrderRiskStyle(payload, "sell");
  const fallbackBuyGuidance = buildFallbackBuyGuidance(normalizedAnalysis, payload, language);
  const fallbackSellGuidance = buildFallbackSellGuidance(normalizedAnalysis, payload, language);
  let buyOrderGuidance = normalizeOrderGuidance(normalizedAnalysis.buyOrderGuidance, fallbackBuyGuidance);
  let sellOrderGuidance = normalizeOrderGuidance(normalizedAnalysis.sellOrderGuidance, fallbackSellGuidance);

  const preferredBuyReference = pickRelativeReferencePrice(
    "buy",
    currentPrice,
    [
      ...getBuyReferenceCandidates(normalizedAnalysis, normalizedAnalysis.action || "WAIT"),
      buyOrderGuidance.price
    ],
    buyRiskStyle
  );
  const preferredSellReference = pickRelativeReferencePrice("sell", currentPrice, [
    normalizedAnalysis.resistanceLevels?.primary,
    normalizedAnalysis.resistanceLevels?.secondary,
    normalizedAnalysis.levels?.target,
    sellOrderGuidance.price
  ], sellRiskStyle);

  if (!isGuidancePriceDirectionValid("buy", buyOrderGuidance.price, currentPrice)) {
    buyOrderGuidance = fallbackBuyGuidance;
  }

  if (!isGuidancePriceDirectionValid("sell", sellOrderGuidance.price, currentPrice)) {
    sellOrderGuidance = fallbackSellGuidance;
  }

  if (!shouldKeepBuyReference) {
    buyOrderGuidance = fallbackBuyGuidance;
  }

  if (!shouldKeepSellReference) {
    sellOrderGuidance = fallbackSellGuidance;
  }

  if (shouldKeepBuyReference && preferredBuyReference !== "N/A") {
    buyOrderGuidance = {
      ...buyOrderGuidance,
      price: preferredBuyReference,
      shares: getFallbackReferenceShares("buy", normalizedAnalysis, payload, language, preferredBuyReference),
      reason: buildBuyReferenceReason(
        language,
        normalizedAnalysis.action || "WAIT",
        Number(payload.positionContext?.currentShares ?? 0) > 0
      )
    };
  }

  if (shouldKeepSellReference && preferredSellReference !== "N/A") {
    sellOrderGuidance = {
      ...sellOrderGuidance,
      price: preferredSellReference,
      shares: getFallbackReferenceShares("sell", normalizedAnalysis, payload, language, preferredSellReference),
      reason: buildSellReferenceReason(language, normalizedAnalysis.action || "WAIT")
    };
  }

  if (!hasBuyCapital) {
    buyOrderGuidance = fallbackBuyGuidance;
  }

  return {
    ...normalizedAnalysis,
    sizeSuggestion: buildRiskAwareSizeSuggestion(normalizedAnalysis, payload, language),
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
    `Selected buy risk style: ${formatPromptValue(payload.rules?.buyRiskStyle)}.`,
    `Selected sell risk style: ${formatPromptValue(payload.rules?.sellRiskStyle)}.`,
    "Use EMA 20/50/100/200 only if they are visible in the screenshot. Do not invent EMA relationships.",
    "If the best action is OPEN, ADD, REDUCE, or EXIT, use a LIMIT order and provide a practical limit price.",
    "If the best action is HOLD or WAIT, use orderType NONE and set limitPrice to N/A.",
    "Set currentPrice to the current visible price shown on the chart if it can be read reliably. If it is not readable from the screenshot, use N/A.",
    "Return supportLevels and resistanceLevels as structured objects with primary and secondary price references. Use N/A when only one level is visible.",
    "A valid buy can come from two paths: a patient pullback into visible support, or a stronger reclaim / breakout-hold entry after price retakes a key level and stays above it.",
    "Do not default to HOLD or WAIT just because price is above the deepest support. OPEN or ADD is allowed when the chart shows a credible reclaim and hold above a key level with room toward the next resistance.",
    "Use the selected buy risk style and sell risk style to shape how aggressive or patient the action and size suggestion should be.",
    "Assume the user may be a beginner.",
    "Use plain everyday language in whatToDoNow, summary, and riskNote.",
    "Avoid jargon like breakout, pullback, resistance, support, momentum, invalidation, and EMA stack unless it truly helps.",
    "If you mention a technical term, explain it in simple words immediately.",
    "Prefer short sentences with one idea at a time.",
    "Set whatToDoNow to one clear natural-language instruction that directly tells the user what to do now.",
    "Do not stuff long multi-clause technical commentary into whatToDoNow. Use summary and riskNote for the fuller explanation.",
    "Make sizeSuggestion risk-driven. Tie it to available cash, current position size, and how far the invalidation level is from the current price.",
    "When possible, make sizeSuggestion concrete by giving approximate shares and approximate cash usage for buy ideas, or approximate shares / percentage of position for sell ideas.",
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
    "Keep supportLevels.primary, supportLevels.secondary, resistanceLevels.primary, and resistanceLevels.secondary unchanged when they are raw prices or price zones.",
    "Translate limitPrice only when it contains explanatory text rather than a raw price.",
    "Translate whatToDoNow, sizeSuggestion, summary, levels.entry, levels.target, levels.invalidation, and riskNote into natural Simplified Chinese.",
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
  const analysis = coerceAnalysisDetails(
    coerceDisallowedAction(parseJsonResponse(rawText, "Analysis"), payload, language),
    payload,
    language
  );

  if (language === "zh") {
    const translatedAnalysis = await translateAnalysisToChinese(analysis, settings);

    return coerceAnalysisDetails(
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

