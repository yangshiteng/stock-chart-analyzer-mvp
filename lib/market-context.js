import { getUsTradingDay } from "./market-hours.js";

export const MARKET_CONTEXT_STATUS = {
  MISSING: "missing",
  DAILY_SCANNED: "daily_scanned",
  COMPLETE: "complete"
};

export const MARKET_CONTEXT_MAX_KEY_LEVELS = 10;

const VALID_REGIMES = new Set(["uptrend", "range", "downtrend"]);
// Key-level types are now STATIC FORMATIONS only. Role (support / resistance)
// is resolved at execution time based on current price (anything below acts as
// support, anything above acts as resistance, with role inversion when price
// crosses through). The legacy "support" / "resistance" type values are
// normalized to "pivot" on read for backward compatibility with v16 and
// earlier stored scans.
const VALID_LEVEL_TYPES = new Set(["pivot", "gap", "prior_high", "prior_low"]);
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

function normalizeLevelType(value) {
  // Legacy v16 and earlier stored support/resistance as type values. Map them
  // to "pivot" since the new framework decides role dynamically at exec time.
  if (value === "support" || value === "resistance") {
    return "pivot";
  }
  return VALID_LEVEL_TYPES.has(value) ? value : "pivot";
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
    type: normalizeLevelType(level.type),
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

  // Derived policy fields (aggression / dipBuyPolicy / profitTakingStyle) were
  // removed: the key-levels strategy doesn't use them — trend regime alone is
  // enough context, and entry/exit decisions come from the keyLevels list.
  return {
    regime: VALID_REGIMES.has(summary.regime) ? summary.regime : "range",
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

// Decides whether a previously-stored marketContext should survive a state
// reset (Exit, onStartup, reload). Same-day + COMPLETE → keep; anything else
// → wipe to default. Symbol mismatch is intentionally NOT checked here:
// callers may want to preserve context for inspection even when a different
// ticker is being started; isMarketContextValidForProfile handles the
// symbol gate at consume-time and forces a re-scan if needed.
export function shouldPreserveMarketContextAcrossReset(priorContext, now = new Date()) {
  const normalized = normalizeMarketContext(priorContext);
  return normalized.status === MARKET_CONTEXT_STATUS.COMPLETE
    && normalized.tradingDay === getUsTradingDay(now);
}

function dedupeLevels(levels) {
  // All levels are now equal-priority (no strength tier); prefer daily over 1h
  // when prices coincide, since daily levels have wider relevance.
  const sorted = levels
    .map(normalizeLevel)
    .filter(Boolean)
    .sort((a, b) => {
      const aRank = a.timeframe === "daily" ? 0 : 1;
      const bRank = b.timeframe === "daily" ? 0 : 1;
      return aRank - bRank;
    });
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

export function mergeMarketContextScans({ dailyScan, hourlyScan, symbol, tradingDay }) {
  if (!dailyScan || !hourlyScan) {
    throw new Error("Both Daily and 1H market context scans are required.");
  }

  const dailyRegime = VALID_REGIMES.has(dailyScan.regime) ? dailyScan.regime : "range";
  const hourlyRegime = VALID_REGIMES.has(hourlyScan.regime) ? hourlyScan.regime : "range";
  const regime = resolveRegime(dailyRegime, hourlyRegime);
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
      keyLevels,
      riskNotes: notes.slice(0, 400)
    },
    lastError: null,
    updatedAt: new Date().toISOString()
  };
}
