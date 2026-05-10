import { getUsTradingDay } from "./market-hours.js";

export const MARKET_CONTEXT_STATUS = {
  MISSING: "missing",
  DAILY_SCANNED: "daily_scanned",
  COMPLETE: "complete"
};

export const MARKET_CONTEXT_MAX_KEY_LEVELS = 10;

const VALID_REGIMES = new Set(["uptrend", "range", "downtrend"]);
const VALID_AGGRESSION = new Set(["high", "medium", "low"]);
const VALID_DIP_BUY = new Set(["aggressive", "support_only", "extreme_only"]);
const VALID_PROFIT_STYLE = new Set(["normal", "quick_scalp"]);
const VALID_LEVEL_STRENGTH = new Set(["strong", "medium", "weak"]);
const VALID_TIMEFRAMES = new Set(["daily", "1h"]);

export function createDefaultMarketContext() {
  return {
    status: MARKET_CONTEXT_STATUS.MISSING,
    symbol: null,
    tradingDay: null,
    dailyScan: null,
    hourlyScan: null,
    summary: null,
    lastError: null,
    updatedAt: null
  };
}

function normalizeSymbol(value) {
  return `${value || ""}`.trim().toUpperCase() || null;
}

function normalizeStatus(value) {
  return Object.values(MARKET_CONTEXT_STATUS).includes(value)
    ? value
    : MARKET_CONTEXT_STATUS.MISSING;
}

function normalizeLevel(level) {
  if (!level || typeof level !== "object") {
    return null;
  }

  const price = `${level.price || ""}`.trim();
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    return null;
  }

  return {
    label: `${level.label || ""}`.trim().slice(0, 80) || `${price}`,
    type: ["support", "resistance", "pivot", "gap", "prior_high", "prior_low"].includes(level.type)
      ? level.type
      : "pivot",
    strength: VALID_LEVEL_STRENGTH.has(level.strength) ? level.strength : "medium",
    timeframe: VALID_TIMEFRAMES.has(level.timeframe) ? level.timeframe : "daily",
    price,
    zoneLow: level.zoneLow === null || level.zoneLow === undefined || level.zoneLow === ""
      ? null
      : `${level.zoneLow}`.trim(),
    zoneHigh: level.zoneHigh === null || level.zoneHigh === undefined || level.zoneHigh === ""
      ? null
      : `${level.zoneHigh}`.trim(),
    reason: `${level.reason || ""}`.trim().slice(0, 220)
  };
}

function normalizeSummary(summary) {
  if (!summary || typeof summary !== "object") {
    return null;
  }

  const keyLevels = Array.isArray(summary.keyLevels)
    ? summary.keyLevels.map(normalizeLevel).filter(Boolean).slice(0, MARKET_CONTEXT_MAX_KEY_LEVELS)
    : [];

  return {
    regime: VALID_REGIMES.has(summary.regime) ? summary.regime : "range",
    aggression: VALID_AGGRESSION.has(summary.aggression) ? summary.aggression : "medium",
    dipBuyPolicy: VALID_DIP_BUY.has(summary.dipBuyPolicy) ? summary.dipBuyPolicy : "support_only",
    profitTakingStyle: VALID_PROFIT_STYLE.has(summary.profitTakingStyle) ? summary.profitTakingStyle : "quick_scalp",
    keyLevels,
    riskNotes: `${summary.riskNotes || ""}`.trim().slice(0, 400)
  };
}

export function normalizeMarketContext(value) {
  const base = createDefaultMarketContext();
  if (!value || typeof value !== "object") {
    return base;
  }

  const normalized = {
    ...base,
    ...value,
    status: normalizeStatus(value.status),
    symbol: normalizeSymbol(value.symbol),
    tradingDay: `${value.tradingDay || ""}`.trim() || null,
    summary: normalizeSummary(value.summary)
  };

  if (normalized.summary && normalized.dailyScan && normalized.hourlyScan) {
    normalized.status = MARKET_CONTEXT_STATUS.COMPLETE;
  } else if (normalized.dailyScan) {
    normalized.status = MARKET_CONTEXT_STATUS.DAILY_SCANNED;
  } else {
    normalized.status = MARKET_CONTEXT_STATUS.MISSING;
  }

  return normalized;
}

export function createMarketContextForProfile(profile, now = new Date()) {
  return {
    ...createDefaultMarketContext(),
    symbol: normalizeSymbol(profile?.symbolOverride),
    tradingDay: getUsTradingDay(now),
    updatedAt: now.toISOString()
  };
}

export function isMarketContextValidForProfile(marketContext, profile, now = new Date()) {
  const normalized = normalizeMarketContext(marketContext);
  const symbol = normalizeSymbol(profile?.symbolOverride);

  return Boolean(
    symbol
    && normalized.status === MARKET_CONTEXT_STATUS.COMPLETE
    && normalized.summary
    && normalized.symbol === symbol
    && normalized.tradingDay === getUsTradingDay(now)
  );
}

function getLevelRank(level) {
  const strengthRank = { strong: 0, medium: 1, weak: 2 }[level.strength] ?? 3;
  const timeframeRank = level.timeframe === "daily" ? 0 : 1;
  return strengthRank * 10 + timeframeRank;
}

function dedupeLevels(levels) {
  const sorted = levels
    .map(normalizeLevel)
    .filter(Boolean)
    .sort((a, b) => getLevelRank(a) - getLevelRank(b));
  const kept = [];

  for (const level of sorted) {
    const price = Number(level.price);
    const duplicate = kept.some((existing) => {
      const existingPrice = Number(existing.price);
      return Number.isFinite(existingPrice) && Math.abs(existingPrice - price) / price <= 0.003;
    });

    if (!duplicate) {
      kept.push(level);
    }

    if (kept.length >= MARKET_CONTEXT_MAX_KEY_LEVELS) {
      break;
    }
  }

  return kept;
}

function resolveRegime(dailyRegime, hourlyRegime) {
  if (dailyRegime === hourlyRegime) {
    return dailyRegime;
  }

  if (dailyRegime === "range") {
    return hourlyRegime === "downtrend" ? "downtrend" : "range";
  }

  if (dailyRegime === "uptrend" && hourlyRegime === "downtrend") {
    return "range";
  }

  if (dailyRegime === "downtrend" && hourlyRegime === "uptrend") {
    return "range";
  }

  return dailyRegime;
}

function derivePolicy(regime, dailyRegime, hourlyRegime) {
  if (regime === "uptrend") {
    return {
      aggression: hourlyRegime === "range" ? "medium" : "high",
      dipBuyPolicy: "aggressive",
      profitTakingStyle: "normal"
    };
  }

  if (regime === "downtrend") {
    return {
      aggression: "low",
      dipBuyPolicy: "extreme_only",
      profitTakingStyle: "quick_scalp"
    };
  }

  const conflict = dailyRegime !== hourlyRegime;
  return {
    aggression: conflict ? "low" : "medium",
    dipBuyPolicy: "support_only",
    profitTakingStyle: "quick_scalp"
  };
}

export function mergeMarketContextScans({ dailyScan, hourlyScan, symbol, tradingDay }) {
  if (!dailyScan || !hourlyScan) {
    throw new Error("Both Daily and 1H market context scans are required.");
  }

  const dailyRegime = VALID_REGIMES.has(dailyScan.regime) ? dailyScan.regime : "range";
  const hourlyRegime = VALID_REGIMES.has(hourlyScan.regime) ? hourlyScan.regime : "range";
  const regime = resolveRegime(dailyRegime, hourlyRegime);
  const policy = derivePolicy(regime, dailyRegime, hourlyRegime);
  const keyLevels = dedupeLevels([
    ...(Array.isArray(dailyScan.keyLevels) ? dailyScan.keyLevels : []),
    ...(Array.isArray(hourlyScan.keyLevels) ? hourlyScan.keyLevels : [])
  ]);
  const notes = [
    dailyScan.riskNotes ? `Daily: ${dailyScan.riskNotes}` : "",
    hourlyScan.riskNotes ? `1H: ${hourlyScan.riskNotes}` : ""
  ].filter(Boolean).join(" ");

  return {
    status: MARKET_CONTEXT_STATUS.COMPLETE,
    symbol: normalizeSymbol(symbol),
    tradingDay: tradingDay || getUsTradingDay(),
    dailyScan,
    hourlyScan,
    summary: {
      regime,
      ...policy,
      keyLevels,
      riskNotes: notes.slice(0, 400)
    },
    lastError: null,
    updatedAt: new Date().toISOString()
  };
}
