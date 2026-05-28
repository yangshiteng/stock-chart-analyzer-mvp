import { getAnalysisPromptConfig } from "./prompt-config.js";
import { getLanguage } from "./i18n.js";
import { getSettings } from "./storage.js";
import { guessSymbol, sanitizeUrl } from "./symbol.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
// v19: first_exit mode emits the longest output of any mode — the forced
// reasoning format (current/entry/softStop/hardStop/zone/target/@anchor
// markers) PLUS three stop fields PLUS the model's low-effort reasoning
// tokens. 1200 was too tight: a complex chart could push total output past
// the cap, returning status=incomplete (reason=max_output_tokens), which is
// retryable → slow retry loop → the side-panel button appears stuck on
// "正在开始监控...". Bumped to 2000 to give first_exit headroom.
const ANALYSIS_MAX_OUTPUT_TOKENS = 2000;
const MARKET_CONTEXT_SCAN_MAX_OUTPUT_TOKENS = 1100;
const RETRY_MAX_ATTEMPTS = 3;
const ANALYSIS_VALIDATION_MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1000;
// Hard ceiling on a single OpenAI HTTP call. Without it, a hung/stalled
// connection makes fetch() wait forever — the MV3 service worker eventually
// gets evicted and the side-panel's sendMessage never resolves, leaving the
// button stuck on its loading label with no error. A timeout converts that
// silent hang into a retryable network error (AbortError → retryable).
const OPENAI_REQUEST_TIMEOUT_MS = 90000;
const MARKET_CONTEXT_REGIMES = ["uptrend", "range", "downtrend"];
// Key-level types are now STATIC FORMATIONS only. Role (support/resistance) is
// resolved dynamically at 5-minute analysis time based on current price — a
// level below current price acts as support, above acts as resistance, and the
// role swaps when price crosses through (TA's "polarity inversion" principle).
const MARKET_CONTEXT_LEVEL_TYPES = ["pivot", "gap", "prior_high", "prior_low"];
// Anchor sources for BUY_LIMIT / SELL_LIMIT / SELL_NOW decisions. The AI must
// report which level it picked: static (from MARKET_CONTEXT) or dynamic (live
// chart). Special values: `conservative_estimate` (no key level available),
// `stop_broken` (SELL_NOW because hard stop hit), `force_exit` (SELL_NOW
// because near close).
const ANCHOR_SOURCES = [
  "EMA20", "EMA50", "EMA100", "EMA200", "VWAP",
  "pivot", "gap", "prior_high", "prior_low",
  "conservative_estimate", "stop_broken", "force_exit"
];

// Action vocabulary:
// - BUY_LIMIT: only entry action; orderPrice is the chosen support below current
// - SELL_LIMIT: default exit action; orderPrice is the chosen resistance above current
// - SELL_NOW: hard exit when hard stop is broken OR in force_exit window
const ALLOWED_ACTIONS = ["BUY_LIMIT", "SELL_NOW", "SELL_LIMIT"];
const ENTRY_MODE_ACTIONS = ["BUY_LIMIT"];
// first_exit fires once when the user clicks "Limit filled" — it's a one-shot
// initial analysis to set both soft & hard stops AND the first SELL_LIMIT.
// SELL_NOW is permitted for the (rare) gap-down case where the position is
// already in the hard-exit zone at the moment of fill.
const FIRST_EXIT_MODE_ACTIONS = ["SELL_LIMIT", "SELL_NOW"];
const EXIT_MODE_ACTIONS = ["SELL_NOW", "SELL_LIMIT"];
const FORCE_EXIT_ACTIONS = ["SELL_NOW"];

// anchorSource enum values, grouped by category (see SELL_STRATEGY.md
// "anchorSource 字段定义" section for full semantics).
//
// Static key levels (from Market Context Scan, valid for the trading day).
const STATIC_ANCHORS = ["pivot", "gap", "prior_high", "prior_low"];
// Dynamic anchors (read fresh from the 5-minute chart each round; values
// drift but the anchor name stays the same).
const DYNAMIC_ANCHORS = ["EMA20", "EMA50", "EMA100", "EMA200", "VWAP"];
// Intraday static levels formed during the current trading day (v19 addition).
const INTRADAY_STATIC_ANCHORS = [
  "intraday_high",
  "intraday_low",
  "opening_range_high",
  "opening_range_low",
  "intraday_pivot"
];
// Permanent stop numbers stored on virtualPosition (v19 addition).
// fixed_soft_stop = virtualPosition.stopLossPrice;
// fixed_hard_stop = virtualPosition.hardStopPrice.
// These are independent candidates from the (drifted) dynamic anchor values
// that originally defined them. Only emit during exit mode (post-first-exit).
const FIXED_STOP_ANCHORS = ["fixed_soft_stop", "fixed_hard_stop"];
// Caution zone aggressive target (v19 addition): when AI subjectively
// upgrades to entry+$0.05 with ≥2 numeric evidence. Distinct from
// conservative_estimate (which signifies a passive fallback when the
// candidate pool is empty) — aggressive_recovery is an active decision.
const AGGRESSIVE_RECOVERY_ANCHOR = "aggressive_recovery";
// Fallback when no key level is available in the required candidate range.
const CONSERVATIVE_ESTIMATE_ANCHOR = "conservative_estimate";
// SELL_NOW-only anchors (action is SELL_NOW, not SELL_LIMIT).
const SELL_NOW_ANCHORS = ["stop_broken", "force_exit"];

// All anchorSource values available pre-position (entry mode + first_exit
// mode): everything except fixed_* (no virtualPosition yet) and
// aggressive_recovery (caution-zone-only) and force_exit (mode-locked).
const SHARED_ENTRY_ANCHORS = [
  ...STATIC_ANCHORS,
  ...DYNAMIC_ANCHORS,
  ...INTRADAY_STATIC_ANCHORS,
  CONSERVATIVE_ESTIMATE_ANCHOR
];

// Entry mode: SHARED_ENTRY_ANCHORS only. No SELL_NOW-only anchors (entry
// can only emit BUY_LIMIT).
const ENTRY_ALLOWED_ANCHORS = [...SHARED_ENTRY_ANCHORS];

// First-exit mode: SHARED_ENTRY_ANCHORS + stop_broken (for gap-down
// SELL_NOW). No fixed_* (virtualPosition values are about to be written
// by THIS analysis, can't refer to them yet). No aggressive_recovery
// (first-exit forces defaults per zone, no subjective judgment).
const FIRST_EXIT_ALLOWED_ANCHORS = [...SHARED_ENTRY_ANCHORS, "stop_broken"];

// Exit mode: full enum — SHARED_ENTRY_ANCHORS + fixed_* + aggressive_recovery
// + stop_broken/force_exit (for SELL_NOW). Contextual constraints (e.g.,
// aggressive_recovery only in caution zone) are enforced by the validator.
const EXIT_ALLOWED_ANCHORS = [
  ...SHARED_ENTRY_ANCHORS,
  ...FIXED_STOP_ANCHORS,
  AGGRESSIVE_RECOVERY_ANCHOR,
  ...SELL_NOW_ANCHORS
];

// Force-exit mode: action locked to SELL_NOW; anchorSource locked to
// force_exit.
const FORCE_EXIT_ALLOWED_ANCHORS = ["force_exit"];

function getAllowedAnchors(mode = "entry") {
  if (mode === "force_exit") return [...FORCE_EXIT_ALLOWED_ANCHORS];
  if (mode === "first_exit") return [...FIRST_EXIT_ALLOWED_ANCHORS];
  if (mode === "exit") return [...EXIT_ALLOWED_ANCHORS];
  return [...ENTRY_ALLOWED_ANCHORS];
}

// The buy-side schema is intentionally minimal — entry analysis no longer
// emits stop/target. Stop and target are set on the sell side at the first
// exit analysis right after a BUY_LIMIT fills (see SELL_STRATEGY.md).
function buildEntrySchema(allowedActions, allowedAnchors) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: allowedActions },
      orderPrice: { type: "string" },
      reasoning: { type: "string" },
      symbol: { anyOf: [{ type: "string" }, { type: "null" }] },
      currentPrice: { type: "string" },
      anchorSource: { type: "string", enum: allowedAnchors }
    },
    required: ["action", "orderPrice", "reasoning", "symbol", "currentPrice", "anchorSource"]
  };
}

// First-exit schema fires once at BUY_LIMIT fill time. It MUST emit both
// stops AND a first SELL_LIMIT (or SELL_NOW for catastrophic gap-down).
function buildFirstExitSchema(allowedActions, allowedAnchors) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: allowedActions },
      orderPrice: { anyOf: [{ type: "string" }, { type: "null" }] },
      stopLossPrice: { type: "string" },
      hardStopPrice: { type: "string" },
      targetPrice: { anyOf: [{ type: "string" }, { type: "null" }] },
      reasoning: { type: "string" },
      symbol: { anyOf: [{ type: "string" }, { type: "null" }] },
      currentPrice: { type: "string" },
      anchorSource: { type: "string", enum: allowedAnchors }
    },
    required: [
      "action", "orderPrice",
      "stopLossPrice", "hardStopPrice", "targetPrice",
      "reasoning", "symbol", "currentPrice", "anchorSource"
    ]
  };
}

// Regular exit / force_exit schema. Stops are stored in virtualPosition; AI
// doesn't re-emit them. orderPrice is the SELL_LIMIT target or null for
// SELL_NOW.
function buildExitSchema(allowedActions, allowedAnchors) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: allowedActions },
      orderPrice: { anyOf: [{ type: "string" }, { type: "null" }] },
      reasoning: { type: "string" },
      symbol: { anyOf: [{ type: "string" }, { type: "null" }] },
      currentPrice: { type: "string" },
      anchorSource: { type: "string", enum: allowedAnchors }
    },
    required: ["action", "orderPrice", "reasoning", "symbol", "currentPrice", "anchorSource"]
  };
}

// Build the right schema for the given mode.
function buildAnalysisJsonSchema(mode, allowedActions) {
  const allowedAnchors = getAllowedAnchors(mode);
  if (mode === "first_exit") return buildFirstExitSchema(allowedActions, allowedAnchors);
  if (mode === "exit" || mode === "force_exit") return buildExitSchema(allowedActions, allowedAnchors);
  return buildEntrySchema(allowedActions, allowedAnchors);
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
  if (mode === "force_exit") return [...FORCE_EXIT_ACTIONS];
  if (mode === "first_exit") return [...FIRST_EXIT_MODE_ACTIONS];
  if (mode === "exit") return [...EXIT_MODE_ACTIONS];
  return [...ENTRY_MODE_ACTIONS];
}

function normalizeMode(mode) {
  if (mode === "first_exit" || mode === "exit" || mode === "force_exit") return mode;
  return "entry";
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

function validateBuyLimit(analysis, currentPrice) {
  // BUY_LIMIT must be at a key level BELOW current price. The key-levels
  // strategy explicitly excludes "marketable limit at current price" — every
  // BUY_LIMIT is a pre-placed bid at a level that price has to come down to.
  const orderPrice = parsePriceField(analysis.orderPrice, "orderPrice");
  if (orderPrice >= currentPrice) {
    throw new Error("Model returned invalid BUY_LIMIT: orderPrice must be strictly below currentPrice (BUY_LIMIT is a pre-placed bid at a support key level below current price).");
  }
}

function validateAnchorSource(analysis, mode) {
  const anchor = `${analysis.anchorSource || ""}`.trim();
  if (!anchor) {
    throw new Error("Model returned missing anchorSource. Every action must cite the key level it was anchored to.");
  }
  // v19: enforce per-mode anchorSource enum at the validator level
  // (in addition to the JSON schema enum). This catches cases where the AI
  // hallucinates an anchor name (e.g., "support") or uses an out-of-scope
  // anchor (e.g., fixed_soft_stop in entry mode where there's no
  // virtualPosition yet, or aggressive_recovery in entry/first_exit
  // mode where AI subjective judgment is disabled).
  const normalizedMode = normalizeMode(mode);
  const allowed = getAllowedAnchors(normalizedMode);
  if (!allowed.includes(anchor)) {
    throw new Error(
      `Model returned anchorSource="${anchor}" which is not allowed in ${normalizedMode} mode. ` +
        `Allowed in ${normalizedMode} mode: ${allowed.join(", ")}.`
    );
  }
  void ANCHOR_SOURCES;
}

// v19: caution-zone aggressive target uses anchorSource=aggressive_recovery,
// distinct from conservative_estimate (passive fallback). This check enforces
// that aggressive_recovery only appears when currentPrice is actually in the
// caution zone (hardStop < currentPrice ≤ softStop). Outside the caution zone
// it's a semantic error — AI must use a real anchor or the appropriate
// per-zone default.
function validateAggressiveRecoveryZone(analysis, currentPrice, softStop, hardStop) {
  if (analysis.anchorSource !== "aggressive_recovery") {
    return;
  }
  // If stops aren't available in context (defensive null), skip the zone check
  // — we can't determine zone without them. This is a degraded path; in
  // production exit mode the validator should always receive both stops via
  // validationContext.
  if (!Number.isFinite(softStop) || !Number.isFinite(hardStop)) {
    return;
  }
  if (currentPrice > softStop) {
    throw new Error(
      `Model used anchorSource=aggressive_recovery but currentPrice (${currentPrice}) is ABOVE softStop (${softStop}) — not in caution zone. ` +
        `aggressive_recovery is only valid when hardStop < currentPrice ≤ softStop.`
    );
  }
  if (currentPrice <= hardStop) {
    throw new Error(
      `Model used anchorSource=aggressive_recovery but currentPrice (${currentPrice}) is AT OR BELOW hardStop (${hardStop}) — in hard-exit zone, must be SELL_NOW. ` +
        `aggressive_recovery is only valid when hardStop < currentPrice ≤ softStop.`
    );
  }
}

function validateFirstExitResult(analysis, currentPrice, entryPrice) {
  // First-exit analysis (one-shot, fired by markBought / confirmMarketContextAndStart
  // right after a position is opened) MUST emit both stops + initial SELL_LIMIT
  // (or SELL_NOW in the rare catastrophic-gap-down case). Stops will be
  // persisted into virtualPosition and remain fixed for the lifetime of the
  // position.
  //
  // CRITICAL: stops are anchored on ENTRY price, not currentPrice. The thesis
  // is built around where the user bought; structural invalidation must be
  // measured from there. For fresh BUY_LIMIT fills these are usually the same
  // (current ≈ entry at fill moment), but for manual_existing_position the
  // current price can already differ from entry significantly.
  const softStop = parsePriceField(analysis.stopLossPrice, "stopLossPrice");
  const hardStop = parsePriceField(analysis.hardStopPrice, "hardStopPrice");

  if (hardStop >= softStop) {
    throw new Error(`Model returned invalid first-exit stops: hardStopPrice (${hardStop}) must be strictly below stopLossPrice (${softStop}).`);
  }

  // Entry-based stop validation. If entryPrice is not available for whatever
  // reason (legacy paths, defensive null), fall back to currentPrice to keep
  // some sanity check rather than no check at all.
  const stopReference = Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : currentPrice;
  const stopReferenceLabel = stopReference === entryPrice ? "entryPrice" : "currentPrice (entryPrice unavailable)";
  if (softStop >= stopReference && analysis.action !== "SELL_NOW") {
    throw new Error(`Model returned invalid first-exit stops: stopLossPrice (${softStop}) must be strictly below ${stopReferenceLabel} (${stopReference}).`);
  }

  if (analysis.action === "SELL_LIMIT") {
    const orderPrice = parsePriceField(analysis.orderPrice, "orderPrice");
    if (orderPrice <= currentPrice) {
      throw new Error("Model returned invalid SELL_LIMIT in first-exit mode: orderPrice must be strictly above currentPrice.");
    }
  } else if (analysis.action === "SELL_NOW") {
    validateNoOrderPrice(analysis);
  }
}

function validateExitResult(analysis, currentPrice) {
  // Regular exit mode (scheduled rounds while holding). Stops are already
  // stored in virtualPosition; AI only emits action + orderPrice + anchor.
  if (analysis.action === "SELL_LIMIT") {
    const orderPrice = parsePriceField(analysis.orderPrice, "orderPrice");
    if (orderPrice <= currentPrice) {
      throw new Error("Model returned invalid SELL_LIMIT: orderPrice must be strictly above currentPrice in exit mode.");
    }
  } else if (analysis.action === "SELL_NOW") {
    validateNoOrderPrice(analysis);
  }
}

// v19 Stage 4b: REASONING FORCED FORMAT enforcement.
//
// The per-mode prompt rules (see prompt-config.js entryModeRules /
// exitModeRules / firstExitModeRules) require AI to write reasoning in a
// structured format that includes a zone/judgment chain. This validator
// enforces the bare minimum marker strings — full text format compliance is
// the AI's responsibility, but missing the marker = clear non-compliance.
//
// Markers per mode:
//   - entry:        must contain "current=", "candidates", "mode="
//   - first_exit:   must contain "zone="
//   - exit:         must contain "zone="
//   - force_exit:   no format required (action locked to SELL_NOW, prompt is
//                   one-line)
//
// Empty / very short reasoning fails the action-level validators upstream
// (parsePriceField etc. don't depend on reasoning); but if AI returns a
// plausible-looking sentence without the v19 markers, we want a clear error.
function validateReasoningFormat(analysis, mode) {
  const reasoning = `${analysis.reasoning || ""}`;
  if (reasoning.length === 0) {
    throw new Error("Model returned empty reasoning. v19 requires structured reasoning per mode.");
  }
  // v19 R4 fix: marker checks are case-insensitive. The prompt instructs AI
  // to use lowercase markers (current=, mode=, zone=) but AI can occasionally
  // capitalize ("Current=", "Mode="). Accepting case variants avoids
  // unnecessary retries for cosmetic differences.
  const missing = [];
  if (mode === "entry") {
    if (!/\bcurrent\s*=/i.test(reasoning)) missing.push("current=");
    if (!/\bcandidates\b/i.test(reasoning)) missing.push("candidates");
    if (!/\bmode\s*=/i.test(reasoning)) missing.push("mode=");
  } else if (mode === "exit" || mode === "first_exit") {
    if (!/\bzone\s*=/i.test(reasoning)) missing.push("zone=");
  }
  if (missing.length > 0) {
    throw new Error(
      `Model returned reasoning missing required v19 marker(s) for ${mode} mode: ${missing.join(", ")}. ` +
        `Reasoning was: "${reasoning}". See prompt-config.js entryModeRules / exitModeRules for the forced format.`
    );
  }
}

// v19 Stage 4b: AGGRESSIVE EVIDENCE enforcement.
//
// AI subjective judgment in 3 places permits an "aggressive" choice that
// upgrades from the default conservative target to a more aggressive one:
//   - entry mode:        mode=aggressive (挂 R2 instead of R1)
//   - exit observation:  flow=push-rebound (走止盈 R1 above entry instead of
//                                           走解套 fallback ≤ entry+$0.05)
//   - exit caution:      target=aggressive (entry+$0.05 instead of softStop)
//                        OR anchorSource=aggressive_recovery (same thing)
//
// In all three, strategy docs (SELL_STRATEGY.md / BUY_STRATEGY.md) require
// ≥2 numbered observable evidence items in reasoning. Mechanically:
//   - reasoning must contain "(1)" AND "(2)" markers (numbered evidence list)
//   - reasoning must NOT contain bare fuzzy adjectives (looks/feels/seems/
//     should/probably/likely/momentum/bullish/bearish) used without numbers
//
// The constraint exists because LLMs tend to substitute reasoning fluency
// for evidence strength when allowed to use natural-language descriptors.
// Forcing numbered evidence + banning fuzzy words structurally prevents
// "看起来很 confident 但其实信号差" failure mode (see SELL_STRATEGY.md
// "设计权衡" section).
// Each alternative carries its own word-boundary anchors so the regex
// matches consistently regardless of position in the reasoning string.
// (Wrapping the whole group in \b broke matches like " bullish setup" because
// the outer \b assertion failed at the leading space.)
//
// Note: we deliberately do NOT ban standalone `\bbullish\b` / `\bbearish\b`.
// These words frequently appear as legitimate technical pattern qualifiers
// ("bullish engulfing", "bearish flag", "bullish reclaim of EMA20") backed
// by concrete numbers in the same evidence clause. Banning them as
// standalone fuzzy words would block compliant reasoning. The compound
// fuzzy phrases like "looks bullish" / "feels strong" remain banned
// because those ARE the failure mode — using the adjective without
// concrete observation backing.
const FUZZY_WORDS_PATTERN = /(\blooks like\b|\blooks (?:bullish|bearish|strong|weak)\b|\bfeels (?:strong|weak|like)\b|\bseems (?:like|to)\b|\bshould (?:rebound|hold|bounce|recover)\b|\bprobably\b|\blikely\b|\bmomentum (?:building|fading|strong|weak)\b)/i;

function isAggressiveChoice(analysis, mode) {
  const reasoning = `${analysis.reasoning || ""}`;
  if (mode === "entry") {
    return /mode\s*=\s*aggressive/.test(reasoning);
  }
  if (mode === "exit") {
    if (/flow\s*=\s*push-rebound/.test(reasoning)) return true;
    if (/target\s*=\s*aggressive/.test(reasoning)) return true;
    if (analysis.anchorSource === "aggressive_recovery") return true;
    // v19 follow-up: healthy zone R1/R2 is now AI subjective too. trend=strong
    // (→ R2, hold for a farther resistance) is the aggressive choice and must
    // carry ≥2 numbered evidence items, same as the other subjective upgrades.
    if (/trend\s*=\s*strong/.test(reasoning)) return true;
  }
  return false;
}

function validateAggressiveEvidence(analysis, mode) {
  if (!isAggressiveChoice(analysis, mode)) return;
  const reasoning = `${analysis.reasoning || ""}`;

  // Must contain numbered evidence list (1) and (2)
  const hasOne = /\(1\)/.test(reasoning);
  const hasTwo = /\(2\)/.test(reasoning);
  if (!hasOne || !hasTwo) {
    throw new Error(
      `Aggressive choice in ${mode} mode requires ≥2 numbered evidence items in reasoning (e.g., "evidence: (1) ...; (2) ..."). ` +
        `Got: "${reasoning}"`
    );
  }

  // Fuzzy-word blacklist
  const fuzzyMatch = reasoning.match(FUZZY_WORDS_PATTERN);
  if (fuzzyMatch) {
    throw new Error(
      `Aggressive reasoning contains fuzzy word/phrase "${fuzzyMatch[0]}" — replace with concrete numbers or position references. ` +
        `Got: "${reasoning}"`
    );
  }
}

// v19 Stage 4b: ANCHOR CROSS-CHECK enforcement.
//
// The reasoning forced format includes "chose=<price>@<anchor>" (entry mode)
// or "target=<price>@<anchor>" (exit mode) where <price> and <anchor> must
// equal the orderPrice and anchorSource fields respectively. This catches
// the failure mode where AI internally reasons about one anchor but emits
// another anchor name in the structured fields — symptom of confused
// reasoning that should be retried.
//
// Tolerance:
//   - price: ±$0.05 (allows placement micro-adjust ±1-3 ticks on penny stocks,
//                    ±a few cents on higher-priced names)
//   - anchor: exact string match
//
// Pattern matched: `(chose|target)=<digits.digits>@<word>` — only checks if
// a chose=/target= clause is actually present in reasoning. Absence is
// caught by validateReasoningFormat (when required by mode).
function validateAnchorCrossCheck(analysis) {
  const reasoning = `${analysis.reasoning || ""}`;
  // Match both bare format `target=PRICE@ANCHOR` and the R1/R2-prefixed
  // variant `target=R1=PRICE@ANCHOR` that appears in healthy-zone examples
  // (where AI labels the chosen rank inline). The optional `R[12]=` prefix
  // is non-capturing — only PRICE and ANCHOR are extracted for cross-check.
  // Also accepts `conservative=`, `aggressive=` etc. for mode-prefix style
  // (e.g., `target=aggressive=27.55@aggressive_recovery`).
  const match = reasoning.match(/(?:chose|target)\s*=\s*(?:[A-Za-z][A-Za-z0-9_-]*\s*=\s*)?([\d.]+)\s*@\s*([A-Za-z_][A-Za-z0-9_]*)/);
  if (!match) return;

  const [, priceStr, anchorStr] = match;
  const declaredPrice = Number.parseFloat(priceStr);
  if (Number.isFinite(declaredPrice) && analysis.orderPrice !== null && analysis.orderPrice !== undefined) {
    const orderPrice = Number.parseFloat(`${analysis.orderPrice}`);
    if (Number.isFinite(orderPrice) && Math.abs(declaredPrice - orderPrice) > 0.05) {
      throw new Error(
        `Reasoning declares chose/target=${declaredPrice}@${anchorStr} but orderPrice field is ${orderPrice}. ` +
          `Cross-check failed (tolerance ±$0.05 for placement micro-adjust).`
      );
    }
  }

  if (anchorStr !== analysis.anchorSource) {
    throw new Error(
      `Reasoning declares chose/target=@${anchorStr} but anchorSource field is "${analysis.anchorSource}". ` +
        `Cross-check failed — reasoning anchor and field anchor must match.`
    );
  }
}

function validateAnalysisResult(analysis, mode = "entry", context = {}) {
  const normalizedMode = normalizeMode(mode);
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
  validateAnchorSource(analysis, normalizedMode);

  // entryPrice is needed for first_exit validation (stops anchor on entry,
  // not current). Caller passes it via context.entryPrice; otherwise undefined.
  const entryPriceRaw = context?.entryPrice;
  const entryPrice = Number.isFinite(entryPriceRaw)
    ? entryPriceRaw
    : Number.isFinite(Number(entryPriceRaw))
      ? Number(entryPriceRaw)
      : NaN;

  // softStop / hardStop are needed in exit mode for v19 caution-zone
  // anchorSource scope check (aggressive_recovery only valid in caution
  // zone). Caller passes via context; if absent we skip the zone check
  // (defensive path — production exit mode always has both stops on
  // virtualPosition).
  const softStopRaw = context?.softStop;
  const softStop = Number.isFinite(Number(softStopRaw)) ? Number(softStopRaw) : NaN;
  const hardStopRaw = context?.hardStop;
  const hardStop = Number.isFinite(Number(hardStopRaw)) ? Number(hardStopRaw) : NaN;

  if (normalizedMode === "entry") {
    // Entry: only BUY_LIMIT allowed, no stop/target on schema.
    validateBuyLimit(analysis, currentPrice);
  } else if (normalizedMode === "first_exit") {
    // First-exit: SELL_LIMIT (normal) or SELL_NOW (gap-down). Stops required.
    // Stops are validated against entry price (not current).
    validateFirstExitResult(analysis, currentPrice, entryPrice);
  } else if (normalizedMode === "exit") {
    // Regular exit: SELL_LIMIT or SELL_NOW. Stops are in virtualPosition.
    validateExitResult(analysis, currentPrice);
    // v19: aggressive_recovery must only appear in caution zone.
    validateAggressiveRecoveryZone(analysis, currentPrice, softStop, hardStop);
  } else if (normalizedMode === "force_exit") {
    // force_exit: SELL_NOW only.
    validateNoOrderPrice(analysis);
  }

  // v19 Stage 4b: reasoning forced format + aggressive evidence + cross-check.
  // These run after action/anchor/price validation so the upstream errors
  // surface first when both fail (more actionable). force_exit is exempt
  // from format requirements (action is locked, reasoning is one-line).
  if (normalizedMode !== "force_exit") {
    validateReasoningFormat(analysis, normalizedMode);
    validateAggressiveEvidence(analysis, normalizedMode);
    validateAnchorCrossCheck(analysis);
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

function formatVirtualPositionLines(virtualPosition, mode = "entry") {
  if (!virtualPosition) {
    return ["No existing position. You are scanning for an entry."];
  }
  const entry = virtualPosition.entryPrice || "unknown";
  const entryTime = virtualPosition.entryTime || "unknown";
  const reason = virtualPosition.reason || "not recorded";
  const entryAnchor = virtualPosition.entryAnchorSource || "unknown";

  // first_exit mode: position was just opened (either via Limit filled or
  // manual existing-position declaration); stops have not been set yet —
  // that's THIS round's job. Don't show stop/hardStop lines.
  if (mode === "first_exit") {
    return [
      `User just opened a long position. This is the FIRST-EXIT analysis.`,
      `Entry price: ${entry}  ← anchor for the stops below`,
      `Entry time (UTC): ${entryTime}`,
      `Entry anchor: ${entryAnchor}`,
      `Entry thesis: ${reason}`,
      `You MUST set stopLossPrice (soft stop) and hardStopPrice (hard stop) for this position.`,
      `**Stops anchor on ENTRY price (${entry}), NOT on currentPrice.** Find the nearest key level below ENTRY for the soft stop, then the next key level below THAT for the hard stop. For a fresh BUY_LIMIT fill, entry ≈ current so this distinction is moot; for a manual_existing_position where the user bought earlier and current price has moved, the entry price is what defines the structural stop levels.`,
      `Both stops will be persisted to virtualPosition and remain FIXED for the lifetime of the position (no trailing).`
    ];
  }

  // Regular exit / force_exit: stops are already set on virtualPosition.
  const softStop = virtualPosition.stopLossPrice || "unspecified";
  const hardStop = virtualPosition.hardStopPrice || "unspecified";
  return [
    `User is already long.`,
    `Entry price: ${entry}`,
    `Entry time (UTC): ${entryTime}`,
    `Soft stop (stopLossPrice, fixed at fill, do not change): ${softStop}`,
    `Hard stop (hardStopPrice, fixed at fill, do not change): ${hardStop}`,
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
  // FIRST_EXIT is a one-shot fresh analysis right after a BUY_LIMIT fills —
  // we want the AI to look at the chart NOW, not be primed by the prior
  // BUY_LIMIT signal (which is now stale / fulfilled).
  if (mode === "first_exit") return null;
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
  const mode = normalizeMode(payload.mode);
  const allowedActions = getAllowedActions(mode);
  const sanitizedUrl = sanitizeUrl(payload.pageUrl);
  const symbolHint = payload.symbolHint || guessSymbol(payload.pageTitle, sanitizedUrl || payload.pageUrl) || "unknown";

  const modeLabel = mode === "force_exit" ? "FORCE_EXIT"
    : mode === "first_exit" ? "FIRST_EXIT"
    : mode === "exit" ? "EXIT"
    : "ENTRY";

  const sections = [
    formatSection("ROLE", [config.role]),
    formatSection("OBJECTIVE", [config.objective]),
    formatSection("SESSION_MODE", [`Mode: ${modeLabel}.`]),
    formatSection("POSITION_CONTEXT", formatVirtualPositionLines(payload.virtualPosition, mode))
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
  } else if (mode === "first_exit" && config.firstExitModeRules) {
    sections.push(formatBulletSection("FIRST_EXIT_MODE_RULES", config.firstExitModeRules));
  } else if (mode === "exit" && config.exitModeRules) {
    sections.push(formatBulletSection("EXIT_MODE_RULES", config.exitModeRules));
  } else if (mode === "force_exit" && config.forceExitRules) {
    sections.push(formatBulletSection("FORCE_EXIT_RULES", config.forceExitRules));
  }

  const requiredSchema = (config.schemaByMode && config.schemaByMode[mode])
    || config.schemaByMode?.entry
    || "";

  sections.push(
    formatBulletSection("EXECUTION_RULES", config.executionRules),
    formatBulletSection("LANGUAGE_RULES", config.languageRules),
    buildLanguageOutputSection(language),
    formatSection("OUTPUT_FORMAT", [
      "Return strict JSON only.",
      `Required fields: ${requiredSchema}`
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
  // AbortController guards against a hung connection (fetch with no timeout
  // waits forever). On timeout we throw a retryable error so callOpenAi's
  // retry loop kicks in, and ultimately a clear error surfaces instead of a
  // permanently stuck UI.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(OPENAI_RESPONSES_URL, {
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
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(
        `OpenAI request timed out after ${Math.round(OPENAI_REQUEST_TIMEOUT_MS / 1000)}s. Network may be slow or the request stalled.`
      );
      timeoutError.retryable = true;
      throw timeoutError;
    }
    // Network-level fetch rejection (no HTTP status) — retryable.
    if (error.status === undefined && error.retryable === undefined) {
      error.retryable = true;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

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

  const mode = normalizeMode(payload.mode);
  const prompt = buildAnalysisPromptFromConfig(getAnalysisPromptConfig(), payload, language);
  const userContent = [
    { type: "input_text", text: prompt },
    { type: "input_image", image_url: payload.imageDataUrl, detail: "high" }
  ];

  // For first_exit validation, the validator needs entryPrice (stops anchor
  // on entry, not on current price). For exit-mode v19 validation, it also
  // needs softStop and hardStop (for aggressive_recovery zone check). Extract
  // all from virtualPosition.
  const validationContext = {
    entryPrice: payload.virtualPosition?.entryPrice
      ? Number(payload.virtualPosition.entryPrice)
      : undefined,
    softStop: payload.virtualPosition?.stopLossPrice
      ? Number(payload.virtualPosition.stopLossPrice)
      : undefined,
    hardStop: payload.virtualPosition?.hardStopPrice
      ? Number(payload.virtualPosition.hardStopPrice)
      : undefined
  };

  let lastValidationError;
  for (let attempt = 1; attempt <= ANALYSIS_VALIDATION_MAX_ATTEMPTS; attempt += 1) {
    const rawText = await callOpenAi({
      apiKey: settings.openaiApiKey,
      model: settings.model || "gpt-5.4",
      userContent,
      schemaName: "stock_chart_execution_signal",
      schema: buildAnalysisJsonSchema(mode, getAllowedActions(mode)),
      maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS
    });

    const parsed = parseJsonResponse(rawText, "Analysis");
    try {
      return validateAnalysisResult(parsed, mode, validationContext);
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
  FIRST_EXIT_MODE_ACTIONS,
  FORCE_EXIT_ACTIONS,
  STATIC_ANCHORS,
  DYNAMIC_ANCHORS,
  INTRADAY_STATIC_ANCHORS,
  FIXED_STOP_ANCHORS,
  AGGRESSIVE_RECOVERY_ANCHOR,
  CONSERVATIVE_ESTIMATE_ANCHOR,
  SELL_NOW_ANCHORS,
  ENTRY_ALLOWED_ANCHORS,
  FIRST_EXIT_ALLOWED_ANCHORS,
  EXIT_ALLOWED_ANCHORS,
  FORCE_EXIT_ALLOWED_ANCHORS,
  buildAnalysisPromptFromConfig,
  buildMarketContextScanPrompt,
  getAllowedActions,
  getAllowedAnchors,
  validateAnalysisResult,
  validateMarketContextScanResult
};
