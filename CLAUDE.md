# auto-stock

Chrome Extension (Manifest V3) that screenshots a TradingView chart on a fixed 5 / 10 / 15 / 30 minute cadence, sends it to OpenAI (vision + Structured Outputs) for an execution recommendation, and shows the result in a side panel. Locked to TradingView so the prompt can rely on a consistent chart layout. Single-user tool (not multi-tenant).

## Tech stack
- MV3 service worker (`background.js`) + offscreen document (`offscreen.js`) for audio
- Side panel UI (`sidepanel.html`/`sidepanel.js`) + popup (`popup.html`/`popup.js`)
- `chrome.alarms` for round scheduling, `chrome.storage.local` for state
- OpenAI Responses API, model `gpt-5.4` (verified to exist — do NOT "fix" it)
- i18n: English + Simplified Chinese, all strings in `lib/i18n.js`
- Optional Discord webhook notifications

## Key files
- `background.js` — service worker, monitoring loop, tab binding, message routing, trade lifecycle handlers
- `lib/llm.js` — OpenAI calls (`callOpenAi` + `callOpenAiOnce` + retry wrapper), Market Context scan prompt, execution prompt assembly, analysis-output validation
- `lib/market-context.js` — Market Context state helpers, same-symbol/same-day validity, Daily + 1H merge policy, key-level dedupe
- `lib/prompt-config.js` — execution prompt config + JSON schema
- `lib/chart-validator.js` — TradingView hostname check (extension is hard-locked to TradingView)
- `lib/symbol.js` — `guessSymbol` + `sanitizeUrl` (pure, unit-tested)
- `lib/market-hours.js` — `isWithinUsMarketHours`, `isNearUsMarketClose`, `getUsTradingDay` (pure, unit-tested, DST-correct)
- `lib/side-panel.js` — side-panel path/availability helpers (`getSidePanelConfigForTab`, `shouldEnableSidePanelForTab`, `enableSidePanelForWindow`, `setSidePanelAvailabilityForTab`)
- `lib/storage.js`, `lib/constants.js` — state/settings helpers, STATUS enum, `STATE_VERSION`, `migrateState()`, `buildResetStatePreservingHistory()`
- `lib/trade-stats.js` — pure real-trade stats aggregator
- `lib/i18n.js` — all user-facing + background-log strings (single source of truth)
- `sidepanel.js`, `sidepanel-other-tab.js`, `popup.js`, `offscreen.js`
- `scripts/run-tests.mjs`, `scripts/lint.mjs` — dependency-free local/CI verification helpers
- `test/*.test.js` — 144 `node:test` unit tests; run `npm run check`

## IMPORTANT: loading the extension

This repo uses a git worktree at `.claude/worktrees/<branch>/`. Chrome's "Load unpacked" must point at whichever directory actually contains the edits you want to test.

- If working in a worktree: load unpacked from the worktree path, not the main repo root.
- After switching branches or worktrees: re-point "Load unpacked" and click reload.
- Symptom of wrong path: edits appear to have no effect, old behavior persists. Already burned a full debug session on this — verify the load path first before hunting bugs.

## Approved improvements — status

Completed (Batch 1):
- #2 onStartup session cleanup (current behavior: clear active plugin session state after browser restart; broker state is re-declared by the user on the next run)
- #3 Tab check only at screenshot moment; removed aggressive onActivated pause
- #12 Merged background `bgText` into `lib/i18n.js`; fixed same-line format bug
- #14 Simplified `shouldEnableSidePanelForTab` — side panel stays enabled for all tabs while RUNNING/PAUSED **(superseded — see "Side panel bound to original tab" below)**

Completed (Batch 2):
- #4 Symbol input (`symbolOverride`) in sidepanel + tightened `guessSymbol` (checks `$TSLA`, URL patterns, title-lead). The earlier multi-platform chart-validator keyword expansion was later removed; the extension is now hard-locked to TradingView (see "Hard-locked to TradingView").
- #6 Merged Chinese translation into a single analysis call via a language-aware `LANGUAGE_OUTPUT` prompt section (translation round-trip removed)
- #8 Exponential backoff in `callOpenAi` (3 attempts, 1s/2s, retries only network errors + HTTP 429/5xx)
- #11 Deduped `callOpenAiJson` / `callOpenAiAnalysis` into one `callOpenAi` + `callOpenAiOnce` pair

Completed (Batch 3):
- #5 Discord notification fires only when `analysis.action` differs from previous round's action
- #9 Recent rounds timeline section in sidepanel (top 10 of `state.results`)
- #10 Market-hours gate (5-minute monitoring is always limited to 9:30–16:00 ET Mon–Fri via `Intl.DateTimeFormat` so DST is correct)
- #15 Debounced sidepanel `render()` (100ms) and `currentShares` input handler (150ms); `storage.onChanged` filters to `local` + `monitorState`/`appSettings`

Completed (Batch 4):
- A1 Sidepanel summary now surfaces `stopReason` while still RUNNING (market-closed skip is visible)
- A2 Alarm handler guards against re-entry via `isRoundInFlight`; staleness timeout (3 min via `roundStartedAt`) prevents deadlock if the service worker is evicted mid-round
- A4 `incomplete: max_output_tokens` is marked retryable and retry wrapper honors an explicit `error.retryable` flag. Current `ANALYSIS_MAX_OUTPUT_TOKENS` is 1200.
- C2 `sanitizeUrl()` strips query + fragment before sending page URL to OpenAI; `guessSymbol` also runs on the cleaned URL
- C4 Stale `isRoundInFlight: true` is cleared by the alarm handler's 3-minute timeout before a fresh round runs
- Non-blocking start: `startMonitoring` / `continueMonitoring` schedule the alarm and fire-and-forget the first round; sidepanel submit has an explicit `catch` so any `sendMessage` failure still re-renders instead of stranding the loading card

Completed (continuous regular-session monitoring):
- Removed the start-form "analysis rounds" selector and the `totalRounds` rule from normalized profiles. `roundCount` remains only as a display/history counter.
- `runMonitoringRound()` no longer auto-pauses after a configured round count. It keeps scheduling by the active interval until the user pauses/stops it or the regular session ends.
- 5-minute monitoring is always regular-session only: before 9:30 ET it stays armed and retries on the selected cadence; at/after 16:00 ET or on weekends it pauses automatically.
- The popup market-hours toggle was removed because the gate is no longer optional.

Completed (explicit broker-state declaration after restart):
- Browser/tab close, extension reload, and Chrome startup intentionally clear active plugin session state via `buildResetStatePreservingHistory()`; `tradeHistory` is preserved, but `virtualPosition`, `pendingLimitOrder`, `monitoringProfile`, and Market Context are session-scoped.
- Popup no longer exposes `Recover Session`. A fresh `Start Monitoring` validates the current TradingView tab and sends the user through setup + Market Context Scan again.
- After Daily + 1H Market Context Scan, the side panel asks whether the user already holds the stock. If yes, the user enters the broker entry price and monitoring starts directly in exit mode; if flat, monitoring starts in entry mode.
- `Exit` is always available and clears plugin session state without trying to infer or mutate broker state. The broker account is the source of truth.

Completed (Batch 5.5 — tracked-but-already-done):
- C3 Timeline rows in sidepanel are colored by `data-action` (green BUY_*, red SELL_*, amber WAIT) — implemented in `sidepanel.css`, logged for audit trail.
- C7 `popup.html` API key input is already `type="password"` — no plaintext exposure. Logged for audit trail.

Completed (Stage B — virtual-position state machine + semi-auto flow):
- `state.virtualPosition` is the single signal for entry vs exit mode (null = scanning entry; object = holding, scanning exit). STATUS enum untouched per the "no ad-hoc flags" rule.
- `lib/llm.js` builds the JSON schema dynamically: entry allows `BUY_LIMIT/WAIT`; exit allows `SELL_NOW/SELL_LIMIT/HOLD`; force_exit locks to `SELL_NOW` only.
- Prompt adds `SESSION_MODE` + `POSITION_CONTEXT` sections and mode-specific rule blocks (`ENTRY_MODE_RULES` / `EXIT_MODE_RULES` / `FORCE_EXIT_RULES`).
- `lib/market-hours.js` exports `isNearUsMarketClose` (10-min lead before 16:00 ET, DST-safe). `runMonitoringRound` flips mode to `force_exit` when holding near close.
- New background handlers: `mark-bought` sets `virtualPosition`; `mark-sold` appends to `state.tradeHistory` and calls `pauseMonitoring` (session ends when flat).
- Sidepanel: position-summary card + manual mark-sold form appear based on `virtualPosition`; mark-bought now flows through `BUY_LIMIT → Mark limit placed → Limit filled` after the limit-only refactor.

Completed (Stage C — trade journal):
- `markSold` persists closed trades to `state.tradeHistory` with `{ id, symbol, entryPrice, entryTime, exitPrice, exitTime, pnlPercent, plannedStopLoss, plannedTarget, heldMinutes, entryAction, reason }`.
- Sidepanel renders a Trade Journal card listing recent closed trades with win/loss tone. Abandoned overnight-gap trades render with `data-tone="abandoned"` + `ABANDONED` badge + a one-line explanation.
- i18n keys: `tradeJournalTitle`, `tradeJournalCopy`, `noClosedTrades`, `tradeAbandonedBadge`, `tradeAbandonedLesson`.
- The journal originally also generated an AI-written "lesson" per trade via a fire-and-forget `generateTradeLesson` OpenAI call. That feature was later removed in full — see "Removed (AI-generated trade lesson)" below. Trade rows are now pure data; the user's own pattern-spotting across rows is the actual reflection loop.
- An older `RECENT_LESSONS` prompt-injection variant was removed even earlier and is still locked out by a regression test asserting legacy `recentLessons` payloads never reach the prompt.

Completed (real-trade stats card):
- `MAX_TRADE_HISTORY = 500` decouples `tradeHistory` retention from `MAX_RESULTS` (20, which is still used for the per-round `results` timeline). See Known risks below.
- `virtualPosition` captures `entryAction` at `markBought` time; `markSold` copies it into the trade record. (The original implementation also captured `entryConfidence` for a `byConfidence` calibration breakdown; that field was removed entirely — see "Removed (LLM self-rated confidence)" below.)
- `lib/trade-stats.js` is a pure aggregator: `computeTradeStats(tradeHistory)` → `{ overall }`. Filters `status:"abandoned"` and non-finite `pnlPercent`.
- Sidepanel Performance Stats card hides entirely when `overall.n === 0`; otherwise renders sample size, win rate, avg/total PnL %, avg held minutes, best/worst trade.
- i18n keys: `statsTitle`, `statsCopy`, `statsOverallHeading`, `statsSampleSize`, `statsWinRate`, `statsAvgPnl`, `statsTotalPnl`, `statsAvgHeld`, `statsBestTrade`, `statsWorstTrade`.
- This is **read-only aggregation of real-trade journal data**, not paper-trading simulation. Paper-trading / Stage D is not planned.

Completed (BUY_LIMIT/SELL_LIMIT unfilled-order tracking — combined A+B):
- **Problem**: AI suggests a limit order, user places it at the broker, next round fires before the limit fills. Without state, the next LLM call has no idea a resting order exists — it may contradict itself, or the user may silently skip a signal change.
- **Prompt side (approach A)**: New `LAST_SIGNAL_AND_ORDER` section in `lib/llm.js` (`formatLastSignalAndOrderSection`). When a `pendingLimitOrder` exists, tells the model "user has placed a BUY_LIMIT @ $X N minutes ago, still resting" + snapshot (entry/stop/target/confidence) + rules: reuse same numbers if still valid; explicitly flag invalidation in reasoning if not. When no pending order but a `lastSignal` exists, provides continuity context. **Omitted in `force_exit` mode** — action is locked to SELL_NOW, continuity is moot.
- **State side (approach B)**: New `state.pendingLimitOrder` field in `createDefaultState()`. Shape: `{ action, limitPrice, stopLossPrice, targetPrice, reasoning, symbol, placedAt, sourceRound }`. (Originally also carried `confidence`; removed with the rest of the AI-self-rated confidence feature — see "Removed (LLM self-rated confidence)" below.) Orthogonal to `virtualPosition`: BUY_LIMIT pending + no position (entry mode); SELL_LIMIT pending + active position (exit mode). Cleared by `markBought` / `markSold` / `markLimitCancelled` / overnight abandon.
- **Handlers**: `markLimitPlaced(payload)` validates action ∈ {BUY_LIMIT, SELL_LIMIT}, position symmetry (BUY_LIMIT requires flat, SELL_LIMIT requires holding), no existing pending, price > 0. `markLimitCancelled()` is idempotent. Message routes: `mark-limit-placed`, `mark-limit-cancelled`.
- **markBought preference**: copies `entryAction` from the pending snapshot when available (falls back to `lastResult.analysis`) so stats attribution stays accurate even when the limit order fills rounds after the original signal.
- **Sidepanel UI**: `markLimitPlacedSection` appears when AI signal is BUY_LIMIT (flat) or SELL_LIMIT (holding) with no pending — prompts for broker fill price. Once marked, `pendingLimitSection` replaces it with action/price/elapsed-time summary + "Limit filled" / "Cancel limit" buttons. Stale warning after 10 min. Signal-changed warning when current AI action differs from pending.
- **i18n**: 17 new keys in both `en` and `zh`: `limitOrderTitle`, `limitOrderCopy`, `limitPriceLabel`, `markLimitPlacedTitle_buy/_sell`, `markLimitPlacedCopy`, `markLimitPlacedButton_buy/_sell`, `limitFilledButton_buy/_sell`, `limitCancelButton`, `limitStaleWarning`, `limitNotLimitSignal`, `limitBuyWhileHolding`, `limitSellWithoutPosition`, `limitAlreadyPending`, `limitPriceInvalid`, `limitSignalChangedWarning`.
- **Tests**: 5 new cases in `test/llm.test.js` covering LAST_SIGNAL_AND_ORDER injection (entry/exit), pending-order text format, force_exit omission, and null-inputs omission. Suite: 65/65 green.
- **Design note**: No automated limit-fill detection. Stays manual on purpose — AI can see price cross the limit, but the user is the source of truth on whether the broker actually filled. Premature automation here = silent position-sync bugs.

Removed (user-context notes — fully deleted):
- **Originally shipped** as a free-text `monitoringProfile.userContext` field (≤ 500 chars) injected as `[USER_CONTEXT]` section into every prompt with anti-bias rules (treat facts as true, treat predictions as USER BIAS, etc.). Both a pre-session textarea and a mid-session editor card existed at various points.
- **Removed in full** (HTML field, sidepanel.js DOM refs and event handler, `formatUserContextSection`, `USER_CONTEXT_MAX_LENGTH`, the section in `buildAnalysisPromptFromConfig`, the `userContext` field on `monitoringProfile` and on the `analyzeChartCapture` payload, 4 i18n keys per language, and the 6 USER_CONTEXT injection tests). One regression test remains asserting the section is **never** emitted even if a stray `userContext` field somehow reaches the prompt builder.
- **Why removed**: the tool is positioned as a **strict price-action analyzer** — AI reads K-line + EMA + VWAP + Volume from the screenshot and nothing else. Free-text notes had three structural problems: (1) AI cannot verify any of it, only trust the user; (2) anti-bias rules reduce but cannot eliminate confirmation bias when users type predictions or directional opinions; (3) most users left the field empty or filled garbage, so signal-to-noise was poor and the field was UI clutter. The single strong counter-case (earnings-day awareness) was rejected separately — US earnings are after-hours, and day traders flatten before close anyway, so intraday 5-min decisions never intersect with earnings release events.
- **If event-day awareness is ever needed in the future**: do NOT re-add free-text notes. Build it as fact-based auto-fetch (SEC EDGAR / Yahoo earnings calendar) injected as a bounded `[EVENT_RISK]` section. Verifiable, no user text input, no bias surface.

Completed (Stage B follow-up — overnight-gap auto-abandon):
- `virtualPosition` now carries `tradingDay` (US/Eastern YYYY-MM-DD) at `markBought` time.
- `lib/market-hours.js` exports `getUsTradingDay(now)`; DST-safe via `Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" })`.
- `abandonStaleVirtualPositionIfNeeded()` runs at the start of every `runMonitoringRound`. If the stored `tradingDay !== today`, the position is cleared, an `{ status: "abandoned", abandonReason: "overnight_gap" }` record is appended to `tradeHistory`, and the session is paused with i18n reason `sessionAbandonedOvernight`.
- Sidepanel Trade Journal renders abandoned trades with `data-tone="abandoned"` (gray, 75% opacity) + `ABANDONED` badge + a one-line explanation that the row was an overnight auto-close, not a real exit.
- Design choice: no user confirmation — per day-trading rule, any cross-day position is invalid by definition. Prevents the "stale ghost position" scenario from power loss / lid-close / Chrome crash.

Completed (VWAP + Volume signal gating in execution prompt):
- **Problem**: prompt told the AI to read price + EMAs but never explicitly named VWAP or volume confirmation, so signals would fire on price-only structure even when volume contradicted (e.g. breakout on no participation).
- **Solution**: extended `lib/prompt-config.js` so VWAP and Volume are first-class focus areas, not optional chart furniture. `chartFocusAreas` now lists "VWAP relationship (price above/below, recent reclaims/rejections)" and "Volume pane (current bar vs prior, expansion/contraction at the level)". `chartGuardrails` adds "do not assume VWAP/Volume are present — only reference them if visible". `executionRules` requires the model to cite at least one of {VWAP, Volume, EMA stack, structural level} in `reasoning` rather than vague "looks bullish" copy.
- **UI**: chart-setup reminder updated in `lib/i18n.js` (en + zh) to include VWAP and Volume alongside EMA 20/50/100/200, since the model can only use what the user actually puts on the chart.
- **Tests**: new case in `test/llm.test.js` ("buildAnalysisPromptFromConfig: prompt teaches AI to use Volume + VWAP") asserts both keywords appear in the assembled prompt and that the guardrail "only if visible" wording is present.
- **Design note**: deliberately kept as prompt-side gating, not schema-side. Adding `volumeConfirmed: boolean` to the JSON schema would invite the model to confidently fill in `true` even when no volume pane is visible. Keeping it in `reasoning` text means the user can spot-check what the model actually saw.

Completed (mandatory Market Context Scan):
- **Problem**: pure 5-minute execution was too trend-following around EMA/VWAP and weak at dip-buying fast drops into older support / taking profit into older resistance. The 5-minute chart often cannot show key levels from weeks/months ago.
- **Design**: after the session form, Start enters `AWAITING_CONTEXT` and requires two screenshots before any 5-minute round can run: Daily / 1D (3-6 months, hide VWAP, hide visible-range High/Low labels) and 1H / 60m (5-20 trading days, VWAP optional, hide visible-range High/Low labels).
- **State**: new `state.marketContext` tracks `{ status, symbol, tradingDay, dailyScan, hourlyScan, summary }`. Validity requires `status=complete`, same ticker, and same US trading day. Missing/stale context forces `AWAITING_CONTEXT`.
- **Prompt**: `analyzeMarketContextScan()` extracts `regime`, up to 10 typed/strength-classified key levels, and risk notes. `lib/market-context.js` merges Daily + 1H into `summary` with `aggression`, `dipBuyPolicy`, and `profitTakingStyle`. The main 5-minute analysis receives `[MARKET_CONTEXT]` every round.
- **Execution guardrail**: `runMonitoringRound()` refuses to analyze if Market Context is invalid. `Start Monitoring` never fires a 5-minute round directly. `Continue` runs immediately only if context is still valid; otherwise it returns to the Market Context Scan UI. `Stop` preserves context; `Exit` clears it with the rest of active session state.
- **Migration**: `STATE_VERSION = 5`; v4 and earlier states reset `marketContext` so stale or differently-shaped context cannot leak into a new prompt.
- **Tests**: Market Context helper tests, prompt assembly tests for scan + `[MARKET_CONTEXT]`, storage migration v5, and side-panel routing fallback for the mandatory setup path.

Removed (long-term context — fully deleted):
- **Original idea**: optional Daily / Weekly chart scan before Start, stored as `longTermContextDraft`, copied into `monitoringProfile.longTermContext`, and injected as `[LONG_TERM_CONTEXT]` into every 5-minute execution prompt.
- **Why removed**: user decided the product should stay focused on day-trading execution. Mixing higher-timeframe swing context into a strict 5-minute intraday prompt made the strategy less coherent and could weaken stop discipline.
- **Deleted**: start-form widget, long-term CSS, i18n keys, `generate-long-term-context` background route, `generateLongTermContext()` / long-term schema / `LONG_TERM_PROMPT_CONFIG`, `[LONG_TERM_CONTEXT]` prompt injection, and the old long-term injection tests.
- **Historical migration**: v4 stripped legacy `monitoringProfile.longTermContext`, `lastMonitoringProfile.longTermContext`, and root `longTermContextDraft`; current `STATE_VERSION = 5` keeps that cleanup and also resets stale pre-v5 `marketContext`.
- **Design note**: do not re-add the old optional Daily / Weekly swing-style context. The replacement is the mandatory structured Daily + 1H Market Context Scan above: regime and key levels only, used as an intraday map rather than a long-term thesis.

Completed (Side panel content per-tab — supersedes Batch 1 #14):
- **Problem**: with the original "enabled on every tab" behavior, switching to a non-TradingView tab (news article, email, broker) kept the recommendation card visible — implying the analysis still applied to whatever tab was on top.
- **First attempt (commit `6031120`, did not work)**: tried to make `setOptions({ enabled: false })` *hide* the panel on non-bound tabs. **Chrome MV3 doesn't actually close an open side panel that way.** The per-tab `enabled` flag controls toolbar-icon access and content path, but does NOT close a panel that's already open at the window level. There is **no `chrome.sidePanel.close()` API** — Chromium's deliberate design decision (panel is user-controlled). `window.close()` from inside the panel is also a no-op. So "hide on tab switch" is fundamentally not achievable; commit `6031120` shipped a fix that compiled and passed tests but did nothing visible in practice.
- **Final design**: keep the panel `enabled: true` on every tab during a live session, but **swap the `path`** based on which tab is active.
  - Bound tab → `sidepanel.html` (full UI: recommendation, position, journal, stats…)
  - Non-bound tabs → `sidepanel-other-tab.html` (minimal placeholder: title, "monitored tab: AAPL · TradingView", "Switch to monitored tab" button → `chrome.tabs.update(boundTabId, { active: true })` + `chrome.windows.update(boundWindowId, { focused: true })`)
- **Effect**: panel column always visible (we can't hide it), but content makes the binding obvious. User clicks the button → jumps to bound tab → Chrome's per-tab path updates → full UI re-appears automatically (this part of Chrome's behavior **does** work cleanly).
- **API shape**: new `getSidePanelConfigForTab(state, tabId, validation)` returns `{ enabled, path? }`. Old `shouldEnableSidePanelForTab` retained as a thin shim returning `.enabled` for any callers that only need the boolean. Note: with the new design the boolean is `true` for *both* bound and non-bound tabs during a live session — only the path differs. So if anything checks `enabled` to mean "should I render the full UI", it will be wrong; use `path === SIDEPANEL_PATH` instead.
- **Files added**: `sidepanel-other-tab.html`, `sidepanel-other-tab.js`. CSS rules (`.other-tab-shell`, `.other-tab-card`, etc.) appended to `sidepanel.css`. New `enableSidePanelForWindow` delegates to per-tab `setSidePanelAvailabilityForTab` so all tabs in the window get the right path immediately after Start / Continue, not just on subsequent activations.
- **i18n**: 5 new keys per language: `otherTabTitle`, `otherTabCopy`, `otherTabBoundLabel`, `otherTabSwitchButton`, `otherTabSwitchFailed`.
- **Defensive default**: if `boundTabId` is missing on both profiles (corrupted state), `getSidePanelConfigForTab` returns `{ enabled: false }` for every tab. Hidden panel is a discoverable bug; an "other tab" placeholder leaking onto every tab would be confusing.
- **Tests**: `test/side-panel.test.js` rewritten to assert on the full `{enabled, path}` config. 12 cases covering IDLE/VALIDATING (always disabled), AWAITING_CONTEXT (validated TV tab → full UI), RUNNING/PAUSED bound vs non-bound (full UI vs other-tab placeholder), `lastMonitoringProfile` fallback, defensive default, profile precedence, and back-compat shim agreement. Suite: 96/96.
- **Why Batch 1 #14 was reversed**: that earlier change traded discoverability ("panel visible from any tab") against semantic clarity ("panel reflects the analyzed tab"). Months of use showed the semantic confusion dominates — cards following the user around different tabs felt like the extension was claiming to analyze whatever was on top. The "other tab" placeholder is the right resolution because Chrome won't let us hide the panel; the next-best move is to make the content unambiguous.

Completed (Batch 5 — structural cleanup + tests):
- B1 Extracted `guessSymbol` + `sanitizeUrl` into `lib/symbol.js` (imported by `lib/llm.js` and `lib/chart-validator.js`)
- Extracted `isWithinUsMarketHours` into `lib/market-hours.js`
- B2 Extracted `shouldEnableSidePanelForTab`, `enableSidePanelForWindow`, `setSidePanelAvailabilityForTab` into `lib/side-panel.js`
- B3 Merged trailing `Object.assign(TRANSLATIONS.en/zh, {...})` blocks back into the single dicts in `lib/i18n.js`
- B4 Removed unused `confidence` field from `lib/chart-validator.js`
- B5 Added `node:test` unit tests under `test/` (29 tests: symbol, chart-validator, market-hours, llm). Run via `npm test`.

Completed (action vocabulary — BUY_NOW removed, SELL_NOW restored for exits):
- **Current schema**: `ALLOWED_ACTIONS` is `["BUY_LIMIT", "SELL_NOW", "SELL_LIMIT", "HOLD", "WAIT"]`. `ENTRY_MODE_ACTIONS` = `["BUY_LIMIT", "WAIT"]`. `EXIT_MODE_ACTIONS` = `["SELL_NOW", "SELL_LIMIT", "HOLD"]`. `FORCE_EXIT_ACTIONS` = `["SELL_NOW"]`.
- **Entry rule**: all entries remain limit-only via `BUY_LIMIT`; no `BUY_NOW`.
- **Exit rule**: `SELL_NOW` is allowed in normal exit mode for quick scalp profit, stop-loss, weakening small losses, or capital protection. `SELL_LIMIT` is only for a take-profit limit above current price.
- **Prompt rewrites in `lib/prompt-config.js`**: `actionRules` reserve `SELL_LIMIT` for higher take-profit prices and forbid defensive SELL_LIMIT at/below current price; immediate exits must be `SELL_NOW` with `orderPrice=null`.
- **UI removed**: the entire `markBoughtSection` card (`<section id="markBoughtSection">` in HTML, ~7 DOM refs in sidepanel.js, `markBoughtButton` event handler, the `lastAction === "BUY_NOW"` branch in `renderPositionPanels`). No "manual mark bought" path anymore — entries always flow through `AI BUY_LIMIT → Mark limit placed → Limit filled` (the "Limit filled" button calls `markBought` internally with `pending.limitPrice`). i18n keys `markBoughtTitle / markBoughtCopy / markBoughtButton` deleted (en + zh).
- **UI kept**: `positionActions` card with `exitPriceInput` and "Mark sold at this price" — needed as manual-override exit path (panic close, broker rejected limit, etc.). Pre-filled with `currentPrice` for the convenience case.
- **Backend untouched**: `markBought` and `markSold` handlers in `background.js` are still wired — they're reused by the "Limit filled" button to promote a pending limit into a real position / close. `entryPriceInvalid` and `couldNotMarkBought` i18n keys retained for those paths.
- **Legacy journal data**: pre-refactor `tradeHistory` entries may carry `entryAction: "BUY_NOW"`. The `action_BUY_NOW` i18n key is intentionally retained so historical entries still render correctly in the trade journal.
- **Tests**: `ALLOWED_ACTIONS` / `getAllowedActions` test cases assert the current vocabulary, with explicit assertions that `BUY_NOW` is **not** in any allowed list and `SELL_NOW` is available in normal exit.
- **Why the user pushed for this**: market orders during fast intraday moves frequently filled 1-3 cents off the chart price the user was reading, and stop-loss "panic" SELL_NOW exits were even worse. A marketable limit at the same price fills slightly slower (0–1 ticks) but with bounded slippage. For a strategy that depends on the AI's price levels being right, bounded slippage is non-negotiable.

Completed (analysis-output validation + continuity prompt cleanup):
- **Problem**: after action-vocabulary changes, `LAST_SIGNAL_AND_ORDER` can become stale if examples name removed actions.
- **Prompt fix**: continuity text now says upgrades must stay inside the current allowed vocabulary: entry `WAIT -> BUY_LIMIT`; exit `HOLD -> SELL_NOW` or `SELL_LIMIT`.
- **Validation layer**: `validateAnalysisResult()` checks that the returned action is allowed in the current mode, `BUY_LIMIT` / `SELL_LIMIT` include a positive decimal `orderPrice`, `WAIT` / `HOLD` keep `orderPrice` empty, and entry-mode long setups have `stopLossPrice < orderPrice < targetPrice` with at least 1:1 reward-to-risk.
- **Retry behavior**: invalid structured analysis output gets one fresh model retry (`ANALYSIS_VALIDATION_MAX_ATTEMPTS = 2`). If the second output is still invalid, the round fails and monitoring pauses with the validation error.
- **Tests**: 6 validation tests plus the continuity prompt regression.

Removed (Signal Review / user challenge loop — fully deleted):
- **Originally shipped** as a per-trade "challenge" channel: user sees a signal they disagree with, types a challenge, AI re-analyzes the same chart with the user's argument as `USER_CHALLENGE` and returns a `KEEP / REVISE / EXPLAIN_ONLY` decision. UI rendered a panel under the latest recommendation; accepted reviewed limit signals flowed into a normal `pendingLimitOrder` with `source: "review"`. State carried `lastSignalReview`; STATE_VERSION 4 added it; STATE_VERSION 10 removes it.
- **Removed in full**: HTML panel + ~12 sidepanel.js DOM refs / event handlers / state vars + `renderSignalReviewPanel` + `getDisplayAnalysis`'s reviewed-signal branch + `renderOriginalSignalNote`, `formatReviewDecisionLabel`, `canAcceptReviewSignal`, `getReviewUnavailableReason` helpers, `analyzeSignalReview` + `buildSignalReviewPrompt` + `validateSignalReviewResult` + `buildReviewJsonSchema` + `formatOriginalSignalLines` + `formatPendingLimitReviewLines` + `REVIEW_MAX_OUTPUT_TOKENS` from `lib/llm.js`, `reviewSignal` + `acceptReviewedSignal` + `dismissSignalReview` background handlers + their message routes (`review-signal`, `accept-reviewed-signal`, `dismiss-signal-review`), `lastSignalReview` from `createDefaultState()`, all `lastSignalReview: null` writes in patch sites, ~22 i18n keys per language, ~60 lines of CSS, and 7 review-related tests.
- **Why removed**: same anti-pattern as the deleted `userContext` notes feature — it lets the user inject their own argument into the AI's reasoning at exactly the highest-emotion moment (when they disagree with a signal, which usually means they've already decided to do the opposite). Even with explicit anti-bias rules ("treat as hypothesis, do not flatter"), an LLM that has read the user's argument will pattern-match to find supporting evidence. This breaks the systematic-decision premise that day-trading edge depends on. The right answer to "AI keeps missing X" is to fix the main prompt, not add a per-trade override channel that lets the user vote against the system whenever they feel like it.
- **If something like this is ever needed again**: do NOT re-add the free-form text-challenge path. Build instead an explicit, narrow rule into the main prompt (e.g. "when price is at a Market Context resistance, prefer SELL_LIMIT take-profit even if VWAP looks fine") so the system applies the rule symmetrically to every round, not only when the user happens to dislike the output.
- **Migration**: STATE_VERSION 10 strips the `lastSignalReview` field from any stored state. v9 state with a populated review record is silently cleaned on first read. Test `migrateState: v9 state is upgraded to v10 with lastSignalReview field stripped` regression-locks this.

Completed (stateVersion migration layer):
- `STATE_VERSION = 5` is now part of `createDefaultState()`, and every saved monitor state is normalized through `migrateState()` in `lib/storage.js`.
- Migration strips removed prompt-context fields (`userContext`, `longTermContext`, root `longTermContextDraft`), clears old session signal state that predates `orderPrice`, clears stale pre-v4 signal reviews, resets pre-v5 `marketContext`, restores missing defaults, and caps `results` / `tradeHistory` to `MAX_RESULTS` / `MAX_TRADE_HISTORY`.
- Design note: migration is intentionally pure and exported so future shape changes can be unit-tested without a Chrome runtime. Add a version branch or field cleanup inside `migrateState()` and a focused regression test in `test/storage.test.js` whenever the stored shape changes.
- Tests: `test/storage.test.js` covers invalid input, legacy state preservation, malformed legacy profiles, removed prompt-context stripping, and array capping.

Completed (CI + dependency-free lint/check):
- `npm test` now runs `node scripts/run-tests.mjs`, which imports all `node:test` files in a single process. This avoids the Windows sandbox `spawn EPERM` failure seen with `node --test "test/*.test.js"` while still using the same test framework.
- `npm run lint` runs `node --check` against every `.js` / `.mjs` file (excluding `.git`, `.claude`, `.github`, and `node_modules`). No ESLint dependency by design.
- `npm run check` runs lint + tests.
- `.github/workflows/ci.yml` runs lint and tests on every push and pull request using Node 22.
- Current suite after continuous regular-session monitoring work: 144/144 tests green via `npm run check`.

Completed (performance stats action breakdown removal):
- Removed the Performance Stats "By Action" section because the limit-only action vocabulary leaves `BUY_LIMIT` as the only current entry action. Keeping `BUY_NOW` vs `BUY_LIMIT` buckets only surfaced legacy history and no longer helped calibration.
- `computeTradeStats()` later also lost its `byConfidence` breakdown — see "Removed (LLM self-rated confidence)" below. Now returns only `{ overall }`.

Removed (dip-buy discount — fully deleted):
- **Originally shipped** (STATE_VERSION 11) as `monitoringProfile.rules.dipBuyDiscount`, a user-set minimum dollar buffer between currentPrice and any AI-issued BUY_LIMIT orderPrice. Symmetric to sell-strategy parameterization: `lib/buy-strategy.js` with `DEFAULT_DIP_BUY_DISCOUNT = "0.20"`, prompt section `[BUY_STRATEGY]` in entry mode, hard schema enforcement in `validateAnalysisResult()` (compute `maxAllowed = analysis.currentPrice - dipBuyDiscount`, throw if violated). Start-session form field + runtime adjustment card (`runtimeBuyStrategySection`) + `update-buy-strategy` background handler.
- **Why removed**: real-trade testing exposed two distinct pathologies.
  1. **Limit not filling for long stretches with no price update** — AI gave a BUY_LIMIT well below current price, price drifted sideways, limit sat. The user can already control "wait for deeper dip" by simply not placing the limit at the broker, so the parameter was duplicating user discretion.
  2. **Chase-down race condition** — once the AI's `currentPrice` dropped between rounds (price actually fell toward the resting limit), the validator's `maxAllowed = currentPrice - discount` formula forced the AI to issue a NEW, even-lower BUY_LIMIT. The previous round's resting limit at the broker no longer matched the model's most recent signal, even though that signal would have been right to keep. Effectively the validator was telling the model "the cheaper price gets, the cheaper the limit must be" — the opposite of how a real dip-buy works.
- **Pattern recognition**: same anti-pattern as previously removed features (`userContext` notes, Signal Review). When a user-set parameter and the AI's job overlap, prefer AI judgment over user parameters. The real root cause of the stop-out-then-recovery pain was SELL_NOW sensitivity, not BUY_LIMIT aggression — fix the sell-side gate (deeper structural break required, not just an EMA20 wick) instead of layering a buy-side buffer that fights AI discretion.
- **Deleted**: `lib/buy-strategy.js` + `test/buy-strategy.test.js` (~12 tests). `formatBuyStrategySection`, `buyStrategy` arg on `validateAnalysisResult`, `buyStrategy` field on `analyzeChartCapture` payload, `getBuyStrategyForState` + `updateProfileBuyStrategy` + `updateBuyStrategy` background handler + `update-buy-strategy` message route + `buyStrategy` ingestion in `buildMonitoringProfile`, `dipBuyDiscount` input + `runtimeBuyStrategySection` card + all related DOM refs / handlers / imports in sidepanel, all i18n keys (`dipBuyDiscount`, `dipBuyDiscountHint`, `runtimeBuyStrategyTitle/Copy`, `buyStrategyHoldingHint`, `chooseValidBuyStrategy`, `couldNotUpdateBuyStrategy` in both en + zh). README form bullet removed. `normalizeStoredProfile` keeps `dipBuyDiscount` in its destructure-and-strip block so any stale stored profile is cleaned on read.
- **Migration**: STATE_VERSION 11 → 12 with a v12 hook in `lib/storage.js` that re-normalizes `monitoringProfile` + `lastMonitoringProfile` so the field is stripped from on-disk state during the migration round (not silently on first read).
- **Design note**: the "user parameter → prompt explains → schema validates" pattern is good for **style preferences the AI cannot derive from the chart** (quickProfitDelta captures take-profit magnitude — there is no single chart-right answer for "how much profit is enough"). It is the wrong pattern for **chart-mechanical signals** like "how aggressive should this entry be" or "where does the chart say my thesis is broken" — those are the AI's job, and parameterizing them just lets the user fight the model.
- **If a buy-side gate ever feels needed again**: do not re-add `dipBuyDiscount`. Either (1) tune the prompt's entry rules to demand more confluence before BUY_LIMIT, or (2) add an automatic "skip entry near recent stop-out" rule that fires symmetrically every round, not a user-tunable parameter.

Removed (max-loss delta — fully deleted):
- **Originally shipped** (STATE_VERSION 7) as `monitoringProfile.rules.maxLossDelta`, a user-set fixed dollar drop from entry that triggered `SELL_NOW` regardless of chart structure. Lived alongside `quickProfitDelta` as part of the "sell strategy" sibling pair. Injected into POSITION_CONTEXT as `User max-loss delta: $X / Max-loss trigger price: $Y`. Hardened into `exitModeRules`: *"If current price is at or below the max-loss trigger price, or below the recorded stop-loss, return SELL_NOW."*
- **Why removed**: same anti-pattern as the removed `dipBuyDiscount`. The AI **already** returns its own chart-based `stopLossPrice` each round — that's the structural-invalidation exit (below EMA20 / swing low / VWAP). Layering a tighter fixed-dollar trigger on top forced `SELL_NOW` before structure actually broke, chopping the user out on noise during exactly the kind of chop-then-recovery that the dip-buy debugging surfaced. User-set dollar threshold overrides AI's chart judgment = wrong direction.
- **The asymmetry with `quickProfitDelta`**: stop-loss has a chart-correct answer (thesis invalidated when structure breaks). Take-profit does **not** have a chart-correct answer — you can hold to next resistance, scalp $0.20, or trail. Take-profit is style/magnitude preference, which the AI legitimately cannot know. Keep `quickProfitDelta`; drop `maxLossDelta`.
- **Deleted**: `DEFAULT_MAX_LOSS_DELTA` constant, `maxLossDelta` from `normalizeSellStrategyRules / calculateSellStrategyLevels / buildSellStrategyContext`, the two `User max-loss delta` lines in `formatVirtualPositionLines`, the `max-loss trigger price` half of `exitModeRules` line 49 (kept the `recorded stop-loss` half, which is the AI's own chart-based stop), the Max Loss Delta inputs in both the start-session form and `runtimeSellStrategySection`, the `maxLossPrice` row in the position-summary card, all related i18n keys (`maxLossDelta`, `maxLossTrigger` in en + zh), the `maxLossDelta` ingestion in `buildMonitoringProfile` + `updateSellStrategy`. README form bullet rewritten. `normalizeStoredProfile` keeps `maxLossDelta` in its destructure-and-strip block as legacy cleanup.
- **Migration**: STATE_VERSION 12 → 13 with a v13 hook in `lib/storage.js` that re-normalizes profiles so `maxLossDelta` is stripped from on-disk state during the migration round.
- **If a hard dollar cap on loss is wanted again**: place a stop-loss order at the broker. The broker is the source of truth for position state, and account-level hard protection belongs there — not in the plugin's per-round prompt. Same architectural principle as "broker state is explicit after any reset."

Removed (premarket dip plan — fully deleted):
- **Originally shipped** (STATE_VERSION 6) as an optional pre-open BUY_LIMIT planner that ran only during the 4:00-9:30 ET window. The user typed yesterday's close, the model computed a fixed `-PREMARKET_DIP_DISCOUNT_PERCENT (10%)` reference dip price, then used Market Context support to produce a conservative resting BUY_LIMIT. Adoption created a normal `pendingLimitOrder` with `source: "premarket_dip_plan"` that survived into the live monitoring session; `markBought` had a special `isPremarketAwaitingFill` branch so the limit could fill while still in `AWAITING_CONTEXT`. The flow had its own state field (`state.premarketDipPlan`), its own LLM call (`generatePremarketDipPlan` with strict JSON schema + anti-FOMO validator that rejected entries within 5% of yesterday's close), its own message routes (`generate-premarket-dip-plan` / `adopt-premarket-dip-plan`), and its own side-panel card under Market Context Scan.
- **Why removed**: not a reaction to a bug — a scope-discipline decision. The plugin's mission narrowed to **strict 5-minute intraday execution on TradingView**. Premarket dip-buying overlaps with that mission only in branding, not in mechanics:
  1. **Different time domain** — 4:00-9:30 ET (pre-regular-session) vs. the 9:30-16:00 ET regular session that 5-minute monitoring runs in.
  2. **Different signal grammar** — `% discount from a user-typed reference close` (no chart, fixed threshold) vs. chart-structure signals (EMA/VWAP/Volume readable off a live TradingView screenshot). The model couldn't even see a chart when generating these plans; it relied on Market Context + the typed close.
  3. **Different user-input shape** — user has to remember yesterday's close and type it correctly; the rest of the plugin reads everything off the active TradingView tab.
  4. **User had better external channels** for this kind of pre-open dip planning, so the feature was dormant code adding cognitive overhead without earning its keep.
- **Pattern**: not the same anti-pattern as `dipBuyDiscount` / `maxLossDelta` / userContext / Signal Review. Those features actively damaged the core flow (user parameters overriding AI judgment in the same round). Premarket dip was a parallel, optional flow that didn't damage 5-minute execution — but having it in the side panel diluted the answer to "what does this plugin do." Removing it sharpens the product story without changing how the 5-minute loop behaves.
- **Deleted**: `lib/premarket-dip.js` (`PREMARKET_DIP_DISCOUNT_PERCENT`, `PREMARKET_DIP_WINDOW_START_MINUTE / END_MINUTE`, `isWithinPremarketDipWindow`, `normalizePositiveDecimal`, `calculatePremarketDipReferencePrice`, `buildPendingLimitOrderFromPremarketPlan`) + `test/premarket-dip.test.js`. From `lib/llm.js`: `PREMARKET_DIP_PLAN_MAX_OUTPUT_TOKENS`, `buildPremarketDipPlanJsonSchema`, `validatePremarketDipPlanResult`, `buildPremarketDipPlanPrompt`, `generatePremarketDipPlan`, and the related exports. From `background.js`: `createPremarketDipPlan`, `adoptPremarketDipPlan`, both message routes, the `isPremarketAwaitingFill` branch in `markBought`, all `premarketDipPlan: null` writes in patch sites, and the `getUsTradingDay`-based session-scoping (only used for the plan ID; not the same as the `getUsTradingDay` used for overnight-gap detection on `virtualPosition`, which stays). From `state`: the `premarketDipPlan` field on `createDefaultState`. From `sidepanel.html` + `sidepanel.js`: the entire `premarketDipPanel` card + 9 DOM refs + 3 flags (`isGeneratingPremarketDipPlan`, `isAdoptingPremarketDipPlan`, `premarketReferenceCloseTouched`) + `renderPremarketDipPlanResult` + `renderPremarketDipPlanPanel` + the two click/input handlers. From `lib/i18n.js`: 18 keys per language (en + zh). From `sidepanel.css`: `.premarket-dip-panel`, `.premarket-dip-result`. From `scripts/run-tests.mjs`: the test file entry. README form bullet rewritten to drop the premarket dip mention.
- **Migration**: STATE_VERSION 13 → 14 with a v14 hook in `lib/storage.js` that calls `delete migrated.premarketDipPlan` so the dormant field never re-surfaces. The v6 hook (which originally added `premarketDipPlan: null`) was reduced to a comment-only stub since v14 deletes whatever it would have set. The default state shape no longer carries the field, so `storage.test.js` was updated to assert the field is **absent** rather than `null`.
- **If a premarket dip-buy planner is ever needed again**: do not put it back in this plugin. Either build it as a standalone tool (different time domain = different product), or wire the plugin to a real broker API and let pre-open orders come from there. The "type yesterday's close" UX was the giveaway that this didn't belong here — everything else in the plugin reads inputs off TradingView directly.

Removed (LLM self-rated confidence — fully deleted):
- **Originally shipped** as a required `"confidence": "low" | "medium" | "high"` field on every analysis JSON response, with three reinforcing prompt rules: (1) `executionRules` "`confidence=high` only when ALL of: clear chart structure, readable numeric levels, executable orderPrice, Volume + VWAP agreement"; (2) `executionRules` "VWAP gating ... cap confidence at 'low' and prefer WAIT"; (3) `chartGuardrails` "if VWAP not plotted or volume pane hidden, say so in reasoning and downgrade confidence rather than guessing". Surfaced in three downstream places: recommendation metric card with green/amber/red border tone, `pendingLimitOrder.confidence` and `virtualPosition.entryConfidence` snapshot fields, and a `byConfidence` calibration breakdown in `lib/trade-stats.js` + the side-panel Performance Stats card.
- **Why removed**: multi-week real-trade testing showed **no usable signal differential across the three buckets**. The stats card's `byConfidence` breakdown is the system's intended diagnostic — its job is to validate that high-confidence trades win more than low-confidence trades. After enough closed trades, the buckets did not separate. That's the calibration check failing, which is itself useful information: it tells you the underlying field is noise.
- **Why LLM self-rated confidence is fundamentally hard here**: a well-known limitation in academic literature, and visible in our specific case. LLMs treat internal reasoning fluency as confidence rather than evidence-based probability, so the rating tracks how natural the explanation sounds rather than how good the setup is. Three-bucket classification collapses to `medium` as a safe default; `low` is rarely used because it feels like admitting incompetence. The four-condition "high" hard rule (`clear structure`, `readable levels`, `executable orderPrice`, `Volume + VWAP agreement`) **looked** rigorous but each predicate ("clear", "readable", "agree") was the model's own interpretation — so the gate ran inside the same head doing the rating.
- **Pattern**: different from the actively-harmful removed features (`dipBuyDiscount`, `maxLossDelta`, `userContext`, Signal Review — those overrode AI judgment). Closer to the scope-discipline `premarket dip plan` removal. Confidence wasn't damaging signals per se; it was noise dressed up as information. Real cost: users subconsciously hesitating on `medium` signals or skipping `low` ones, throwing away trades the chart-based prices already vetted. The chart-readable `orderPrice` / `stopLossPrice` / `targetPrice` / R:R already encode setup quality; an additional self-rated bit added nothing.
- **Useful prompt rules were preserved without the confidence label**: the VWAP-contradiction rule now says "return WAIT" directly instead of "cap confidence at 'low' and prefer WAIT". The four-condition gate is now phrased as a setup-quality gate that returns WAIT/HOLD rather than forcing a marginal action with a low rating. Behavioral effect is the same (skip marginal setups); the byproduct rating channel is gone.
- **Deleted**: `confidence` from the OpenAI JSON schema + required list in `lib/llm.js`; from `ANALYSIS_RESPONSE_SCHEMA` in `lib/prompt-config.js`; from `executionRules` four-condition gate (rewritten as a WAIT/HOLD gate); from VWAP gating rule (rewritten as WAIT); from `chartGuardrails` "downgrade confidence" wording (now "prefer WAIT"); from `LAST_SIGNAL_AND_ORDER` snapshot text; from `LANGUAGE_OUTPUT` "Keep ... confidence ... in English" instruction; from Market Context Scan negative-list "Do not include ... confidence" wording. From state shape: `pendingLimitOrder.confidence`, `virtualPosition.entryConfidence`, `tradeHistory[].entryConfidence`, `lastResult.analysis.confidence`, `results[].analysis.confidence`. From `background.js`: writes to all five of those, plus the Discord embed `confidence` field. From `lib/trade-stats.js`: `CONFIDENCE_BUCKETS` constant, `byConfidence` aggregation, `groupBy` helper (now unused); module returns only `{ overall }`. From `sidepanel.js`: `getConfidenceTone`, `formatConfidenceLabel`, the confidence metric card in the recommendation grid, the byConfidence rendering loop, `renderStatBucket` (no longer called), `SMALL_SAMPLE_THRESHOLD` (no longer used), `CONFIDENCE_BUCKETS` import. From `sidepanel.css`: `.metric-card[data-tone^="confidence-"]` family (4 selectors) and the `.stats-row`, `.stats-row-label`, `.stats-row-metrics`, `.stats-metric`, `.stats-metric-pnl`, `.stats-row-empty`, `.stats-row-small`, `.stats-small-sample`, `.stats-table` selectors (only used by the per-bucket rendering). From `lib/i18n.js`: `confidenceLabel`, `confidence_low/medium/high`, `statsByConfidenceHeading`, `statsBucketEmpty`, `statsSmallSampleWarning` keys (en + zh); `statsCopy` tightened to drop the "Breakdowns with n<5" caveat. From tests: `byConfidence` and bucket-related cases in `test/trade-stats.test.js` (replaced with regression tests asserting the field is absent and legacy `entryConfidence` is ignored); `confidence` fields in `test/llm.test.js` fixtures; a new regression in `test/llm.test.js` asserting the prompt never contains `confidence`; a new v15 migration test in `test/storage.test.js`.
- **Migration**: STATE_VERSION 14 → 15 with a v15 hook in `lib/storage.js` that strips `confidence` / `entryConfidence` from `lastResult.analysis`, `pendingLimitOrder`, `virtualPosition`, every `results[].analysis`, and every `tradeHistory[]` entry. Stored journal rows stay intact otherwise — only the dead field is removed.
- **If signal-quality grading is ever needed again**: do not re-add a self-rated label on the analysis JSON. Either (1) compute setup-quality mechanically from the chart-readable fields (e.g. R:R ratio, distance from VWAP, volume ratio) and surface that as a derived score, or (2) gate on visible chart structure inside the prompt (already done — WAIT/HOLD when conditions aren't met). LLM self-report is a dead-end channel for this use case; the four-condition rule survived in the prompt because it's a useful behavioral nudge, but it now drives **action selection** rather than a separate rating field.

Removed (AI-generated trade lesson — fully deleted):
- **Originally shipped** as Stage C alongside the trade journal. After each `markSold`, the background fired a separate `generateTradeLesson` OpenAI call (`LESSON_MAX_OUTPUT_TOKENS = 400`, strict JSON schema `{ lesson: string }`) and wrote a ≤80-char post-mortem string back onto the matching `tradeHistory[].lesson` field by `trade.id`. Fire-and-forget; failures were swallowed so a network blip couldn't strand the session. The side panel rendered a `Generating lesson...` placeholder until the async value arrived.
- **Why removed**: same anti-pattern family as the just-removed self-rated `confidence` and the earlier `userContext` notes — **AI generating content with insufficient input to produce real information**. The `generateTradeLesson` prompt got exactly six fields: `{entryPrice, exitPrice, plannedStop, plannedTarget, heldMinutes, entryAction, thesis-text}`. The model could not see:
  1. Intra-hold chart evolution — what shape the price took between entry and exit
  2. Why the user sold when they did (mid-target SELL_NOW, hit stop, panic, target hit, end-of-session)
  3. Post-exit price action — whether selling early was correct or premature
  4. Concurrent market events — index correlation, news, sector rotation
  5. The user's emotional/strategic state at exit
  Without those, the lesson reduced to templated rephrasings of the six input numbers — useful-sounding sentences that didn't add information the user couldn't see by looking at the journal row directly.
- **Why this matters as a category**: trade reflection is the high-value human work in a trading edge. AI generating a confident-sounding "lesson" in the middle of the journal **competes with** the user's own pattern-spotting attention. Pure data (P&L, held minutes, entry → exit, planned stop/target) is the better reflection material; the user looking at 20 rows of clean numbers spots their own habits more reliably than reading 20 LLM rationalizations.
- **Different from the `confidence` removal**: `confidence` was noise leaking into prompt + display + stats. `lesson` was a separate OpenAI call (real cost, real latency, real async race) producing low-value text. Closer to the `premarket dip` removal in that it was an orthogonal feature that didn't damage 5-minute execution but earned its keep poorly.
- **Deleted**: `LESSON_JSON_SCHEMA`, `LESSON_MAX_OUTPUT_TOKENS`, `buildLessonPrompt`, `generateTradeLesson`, and the export from `lib/llm.js`. From `background.js`: the import, the fire-and-forget IIFE inside `markSold`, the `lesson: null` field on both the normal `markSold` trade record and the abandoned-overnight trade record. From `lib/i18n.js`: `lessonPending` key (en + zh); `tradeJournalCopy` rewritten to drop "with AI-generated lessons for human review" — now just "Closed trades for human review." From `sidepanel.js`: the `lesson` branch + `Generating lesson...` placeholder in trade journal rendering. The `tradeAbandonedLesson` i18n key was **kept** because the abandoned-overnight row still needs a one-line explanation of why it was auto-closed — that's a deterministic system message, not an AI generation. From `sidepanel.css`: `.journal-lesson` renamed to `.journal-abandon-note` (now only used for the abandoned-trade explanation).
- **Migration**: STATE_VERSION 15 → 16 with a v16 hook in `lib/storage.js` that `delete trade.lesson` for every entry in `tradeHistory`. Non-lesson fields are preserved.
- **Tests**: new v16 migration test in `test/storage.test.js` asserts the field is stripped while other fields survive. The unrelated regression for legacy `recentLessons` prompt injection stays — that was an earlier removed feature about feeding lessons BACK into the analysis prompt, removed for the same reason this one was: AI doesn't need (and can't usefully consume) post-hoc trade narratives.
- **If trade reflection feels useful again**: do NOT re-add a per-trade AI call. Either (1) compute deterministic post-hoc tags from journal fields (e.g. "stopped at planned stop", "held past target", "exited before quick-profit") and surface those as tone badges, or (2) build a periodic batch reflection over many trades (weekly summary) where the larger sample compensates for missing context. Single-trade LLM lessons with 6 input fields are structurally too thin.

Completed (key-levels strategy redesign — STATE_VERSION 17, the largest single design change in the project's history):

**Trigger** — multi-week real-trade observation that the EMA/VWAP-anchored prompt produced a structural late-entry / missed-entry pattern. EMAs and VWAP are mathematically lagging (moving averages of past prices) so any "wait for confirmation" rule by definition fires after the move. When price was above the lines, the AI's "wait for pullback" stance led to entries getting stopped on institutional distribution; when price was below, the AI's "wait for stabilization / reclaim" stance led to chasing the bounce after it already happened.

**The new framework, in one paragraph**: every decision is anchored to a key level. Buy = nearest key level below current price; sell = nearest key level above current price; stop = key level just below the buy. Key levels come from both static MARKET_CONTEXT (pivot / gap / prior_high / prior_low) and dynamic 5-minute chart (EMA 20/50/100/200 / VWAP). All levels are equal — no strength tier. Every round always emits a price-bearing action (BUY_LIMIT / SELL_LIMIT / SELL_NOW) — WAIT and HOLD are removed because limit orders are zero-cost when they don't fill. The user decides at the broker whether to actually place each order.

**Five user-confirmed design pillars** (each was discussed and locked individually before any code was touched):
1. **关键点位 framework, not support/resistance**: Role is decided dynamically at execution time by current price position, not pre-classified at scan time. A level below current price acts as support; above acts as resistance; the role inverts when price crosses through (TA's polarity-inversion principle).
2. **No strong/medium/weak classification**: The Market Context Scan no longer asks the model to rate level strength. All extracted levels are equal — proximity to current price + trend regime is the selection filter.
3. **No WAIT / no HOLD**: `ALLOWED_ACTIONS` collapses from 5 actions to 3 (`BUY_LIMIT`, `SELL_LIMIT`, `SELL_NOW`). Limit orders are zero-cost when they don't fill, so "always emit a number" is strictly safer than "withhold a number." The user is the broker-side gatekeeper.
4. **EMA / VWAP are themselves legitimate key levels**, not just trend gauges. Their dynamic values are candidate anchors for BUY_LIMIT / SELL_LIMIT. Each round re-evaluates: if the same anchor's value moved (e.g. EMA20 from 27.50 to 27.55), emit the new value as a "realignment" with explicit reasoning; if the anchor is invalidated (price decisively broke through), switch to a new anchor.
5. **stopLossPrice = nearest key level below the BUY_LIMIT; targetPrice = nearest key level above currentPrice**: everything is symmetric. No percentages, no magic numbers. Stop is recorded at entry and does NOT trail in exit mode (the planned stop is a commitment).

**Action vocabulary collapse**:
- `ALLOWED_ACTIONS`: `[BUY_LIMIT, SELL_NOW, SELL_LIMIT, HOLD, WAIT]` → `[BUY_LIMIT, SELL_NOW, SELL_LIMIT]`
- `ENTRY_MODE_ACTIONS`: `[BUY_LIMIT, WAIT]` → `[BUY_LIMIT]`
- `EXIT_MODE_ACTIONS`: `[SELL_NOW, SELL_LIMIT, HOLD]` → `[SELL_NOW, SELL_LIMIT]`
- `FORCE_EXIT_ACTIONS`: `[SELL_NOW]` (unchanged)

**New required schema field**: `anchorSource` on every analysis output. Values: `EMA20` / `EMA50` / `EMA100` / `EMA200` / `VWAP` / `pivot` / `gap` / `prior_high` / `prior_low` / `conservative_estimate` (no level available) / `stop_broken` (SELL_NOW because stop hit) / `force_exit` (SELL_NOW because near close). Recorded on `pendingLimitOrder.anchorSource`, `virtualPosition.entryAnchorSource`, and every trade journal entry's `entryAnchorSource` — provides the audit trail needed to evaluate which anchor types are working over time.

**Validator changes**:
- NEW: BUY_LIMIT `orderPrice` MUST be strictly < `currentPrice` (pre-placed bid at a support below, not a marketable limit at current).
- NEW: every action MUST include `anchorSource`.
- REMOVED: R:R ≥ 1:1 hard floor — the key-levels strategy depends on aggregate edge across many small attempts, not per-trade R:R. The user can decide at the broker whether tight-R:R signals are worth placing.
- REMOVED: stop-orderPrice distance "0.3-2%" range — stop is a key level, distance is whatever the chart gives.

**Prompt rewrite** (in `lib/prompt-config.js`):
- `chartFocusAreas`: key levels (static + dynamic from EMA/VWAP) is now the **first** bullet. Trend description is informational only.
- `entryModeRules`: complete rewrite. Steps 1-5: collect candidates below, pick nearest, emit BUY_LIMIT, stop = next level below order, target = nearest level above current.
- `exitModeRules`: complete rewrite. Priority 1: stop break → SELL_NOW. Priority 2: SELL_LIMIT at nearest key level above current. No HOLD.
- `executionRules`: collapsed from 13 rules to 6. Removed: Volume gating, VWAP gating, four-condition Setup-quality gating, R:R floor, stop-distance range.
- `LAST_SIGNAL_AND_ORDER` section now emits THREE-WAY continuity rules (anchor unchanged + value unchanged → repeat; anchor unchanged + value moved → realign; anchor invalidated → switch). Includes `anchorSource` in the snapshot.

**Market Context Scan changes** (in `lib/llm.js` + `lib/market-context.js`):
- `MARKET_CONTEXT_LEVEL_TYPES` enum: dropped `support` and `resistance` (role is dynamic), kept `pivot` / `gap` / `prior_high` / `prior_low`.
- `MARKET_CONTEXT_LEVEL_STRENGTHS` constant entirely removed.
- `keyLevels[].strength` field removed from schema and validator.
- Derived summary fields `aggression` / `dipBuyPolicy` / `profitTakingStyle` removed — only `regime` / `keyLevels` / `riskNotes` remain. The new strategy doesn't use derived policy hints.
- `derivePolicy()` helper removed. `dedupeLevels()` simplified to prefer-daily-over-1h ranking (no strength tier).
- `normalizeLevel()` normalizes legacy `type=support` / `type=resistance` values to `type=pivot` on read for backward compatibility with v16 and earlier stored scans.

**Sell strategy entire feature deleted** (the last remaining user-set parameter):
- `lib/sell-strategy.js` + `test/sell-strategy.test.js` removed.
- `quickProfitDelta` form field, runtime adjustment card, all DOM refs, populate/render functions, update handler, message route, and i18n keys removed (~14 keys per language).
- `Quick Profit Trigger` row removed from the position summary card.
- `formatVirtualPositionLines` no longer takes a `sellStrategy` argument.
- `analyzeChartCapture` payload no longer includes `sellStrategy`.
- `normalizeMonitoringProfileRules` / `normalizeStoredProfile` keep `quickProfitDelta` in their destructure-and-strip block for legacy data cleanup.

**Side panel UI changes**:
- Recommendation card now shows the `anchorSource` as a dedicated metric (e.g. `Anchor: EMA20`) — visible audit of which level drove each signal.
- Position summary shows `entryAnchorSource` so you can see which anchor the trade started at, regardless of when it filled.
- Form simplified to just: Ticker / Entry / Pending / Position scan intervals. Quick Profit Delta field gone.

**Migration STATE_VERSION 16 → 17**:
- Re-normalizes `monitoringProfile` + `lastMonitoringProfile` to strip `quickProfitDelta`.
- Re-normalizes `marketContext` via `normalizeMarketContext()` to strip `aggression` / `dipBuyPolicy` / `profitTakingStyle` from the summary and `strength` from every `keyLevels[]` entry; legacy `type=support` / `type=resistance` values are mapped to `type=pivot`.
- Legacy stored WAIT / HOLD entries in `lastResult.analysis.action` and `results[].analysis.action` are intentionally left alone as audit-trail breadcrumbs — they cannot be re-emitted as live action because the validator and schema have changed.

**Tests**: 137 → 135. Net -2 (deleted 6 sell-strategy tests; added 4 new tests for the anchorSource requirement, the orderPrice < currentPrice rule, the legacy support/resistance-type-rejection, the role-is-dynamic Market Context note). Suite green.

**Why this is the largest single change so far** — every prior removal (`userContext`, `dipBuyDiscount`, `maxLossDelta`, premarket dip, `confidence`, `lesson`) was a single isolated feature. This one rewrites the **core decision logic** of the plugin, simplifying the action vocab, schema, validator, prompt, and Market Context shape simultaneously. The result is a strategy that is structurally simpler (one decision rule applied symmetrically) and philosophically purer (every signal anchored to an audit-trail-visible key level).

Completed (dual-stop + three-zone exit strategy — STATE_VERSION 18, follow-up to the key-levels redesign):

**Motivation**: under v17, exit logic was just "nearest resistance above current price"; stop was a single line that triggered `SELL_NOW` the moment it broke. Real-trade testing exposed the user's actual pattern: support breaks are often "假破" (false break) where the next deeper support holds and price recovers. Forcing SELL_NOW on the first break loses these recoveries. But naively waiting longer is the classic blowup recipe. Solution: **two stops** — a soft one that triggers "give it a chance" recovery mode, and a hard one that triggers unconditional exit.

**Two design docs were written first** (in repo root): `BUY_STRATEGY.md` and `SELL_STRATEGY.md`. These are now the canonical specs; any future refinements should update them.

**Schema split — mode-aware schemas**. Single `buildAnalysisJsonSchema(allowedActions)` replaced by four variants:
- `entry`: `{action: BUY_LIMIT, orderPrice, anchorSource, reasoning, symbol, currentPrice}` — drops stop/target entirely
- `first_exit`: same as entry's fields PLUS `stopLossPrice`, `hardStopPrice`, `targetPrice` required
- `exit`: just `{action, orderPrice, anchorSource, reasoning, symbol, currentPrice}` — stops are on virtualPosition, not re-emitted
- `force_exit`: same as exit (action locked to SELL_NOW)

**Action vocabulary**:
- `ENTRY_MODE_ACTIONS`: `["BUY_LIMIT"]` (unchanged)
- `FIRST_EXIT_MODE_ACTIONS` (NEW): `["SELL_LIMIT", "SELL_NOW"]` — SELL_NOW for catastrophic gap-down
- `EXIT_MODE_ACTIONS`: `["SELL_NOW", "SELL_LIMIT"]` (unchanged)
- `FORCE_EXIT_ACTIONS`: `["SELL_NOW"]` (unchanged)

**Trigger pathway for first_exit** — this is the most novel piece. Previously `markBought` was a simple state write. Now it's a 2-step:
1. Validate inputs and capture the live chart screenshot
2. Run a one-shot `analyzeChartCapture({mode: "first_exit", ...})`
3. If the AI call fails, `markBought` THROWS — the position is NOT recorded, user sees an error and retries. This is intentional: a position without stops is worse than no position
4. If success, write `virtualPosition` with `stopLossPrice` (soft) + `hardStopPrice` (hard) + the AI's initial SELL_LIMIT as `lastResult.analysis`
5. The fresh `lastResult` includes `isFirstExit: true` so the side panel can flag it

**Three-zone state machine** — encoded entirely in `exitModeRules` prompt; no dedicated code path. AI reads `virtualPosition.stopLossPrice` + `virtualPosition.hardStopPrice` + `currentPrice` and decides:
- `current > softStop` → take-profit zone → SELL_LIMIT at nearest resistance above
- `hardStop < current ≤ softStop` → recovery zone → SELL_LIMIT at nearest resistance above AND ≤ entry (break-even target)
- `current ≤ hardStop` → must-exit zone → SELL_NOW

**Stops are PERMANENT** — set at fill time, do not trail upward as price rises. The trade's commitment is fixed at entry. Future work may add trailing if real-trade testing shows the user gives back too much profit.

**No averaging-down in v1** — the user originally proposed letting recovery zone include "place additional BUY_LIMIT at deeper support to lower average cost". Deferred because: (1) classic Martingale trap on cascade days, (2) plugin's architecture assumes single position per session (multi-fill, partial-fill, multi-stop management would be a major rewrite), (3) the recovery zone's break-even-target SELL_LIMIT already captures most of the upside without the position-sizing risk.

**Files touched**:
- `lib/constants.js`: STATE_VERSION 17 → 18
- `lib/llm.js`: 4 schema builders + `getAllowedActions` extended + `normalizeMode` + `validateFirstExitResult` + `formatVirtualPositionLines(virtualPosition, mode)` + `buildAnalysisPromptFromConfig` handles first_exit
- `lib/prompt-config.js`: rewritten — `firstExitModeRules` added, `exitModeRules` rewritten as three-zone, `schemaByMode` for per-mode required-fields hint
- `lib/storage.js`: v18 migration hook adds `hardStopPrice: null` to any pre-existing virtualPosition
- `background.js`: `markBought` becomes async 2-step; captures live screenshot then runs `analyzeChartCapture(mode: "first_exit")` and persists the dual stops + initial SELL_LIMIT; failure throws so the position isn't recorded without stops
- `sidepanel.js`: `computeZoneLabel(language, position, state)` helper; position-summary card now shows softStop, hardStop, entryAnchor, and current zone
- `lib/i18n.js`: 10 new keys per language (softStopLabel, hardStopLabel, zoneLabel + 4 zone names + 2 first_exit error strings, en + zh)
- `BUY_STRATEGY.md` + `SELL_STRATEGY.md`: canonical specs added to repo root
- Tests: 135 → 138 (added: first_exit prompt assembly test, first_exit dual-stop validator tests, gap-down SELL_NOW test; updated: entry mode no longer requires stop/target in schema)

**Design tension we resolved**: the user kept proposing variations that would reintroduce subjective choice (averaging-down, "3 limit candidates", trend-based target selection). Each time, the response was the same: don't let user preference participate in AI decisions; aggregate edge across deterministic rules beats discretionary tuning. This is the same pattern that drove `userContext` / `dipBuyDiscount` / `maxLossDelta` / `confidence` removals.

## Future work / not planned

### Known risks / follow-ups (small)
- `state.tradeHistory` now uses its own `MAX_TRADE_HISTORY = 500` (previously reused `MAX_RESULTS = 20`, which silently dropped journal entries after ~20 trades). Decoupled so months of history survive for human review + real-trade stats. 500 is not unbounded — if a user ever runs for multiple years, consider export-to-CSV + purge, or a separate `journalArchive`.
- `tradeHistory` is now preserved across every state reset via `buildResetStatePreservingHistory()` helper. Reset paths include `onInstalled` (reload/update), `onStartup` when active session state exists, `exitMonitoring` (Exit button), monitored-tab close, and `runValidationPreflight` (fires on every Start Monitoring click). Other state fields (virtualPosition, pendingLimitOrder, monitoringProfile, results, Market Context, …) intentionally reset to defaults in those paths — only tradeHistory is protected. If the shape of `tradeHistory` entries ever changes, add a one-off migration inside the helper; it's the single chokepoint for cross-version journal preservation.
- No tab-activity freshness check: if user leaves the tab backgrounded for 30+ min, the screenshot still fires on schedule but the chart data may be stale. Currently ignored because users actively watching wouldn't hit this; worth revisiting if false signals correlate with tab-switch patterns.

### Hard-locked to TradingView (do not relax)
- `lib/chart-validator.js` is a **hostname check** against `tradingview.com` / `cn.tradingview.com` (and their subdomains). Multi-platform keyword matching (Yahoo, 雪球, 东方财富, 富途, 老虎, 长桥, 同花顺, 新浪, seeking alpha, investing.com, barchart, stockcharts, finviz, robinhood, webull, etrade, marketwatch) was deleted in this iteration — do **not** add platforms back without first re-discussing the prompt design.
- **Why**: predictable chart layout = stable screenshot grammar = consistent prompt input. The execution prompt and the recommended TradingView shared layout (linked from README) work together as one product surface.
- **One-click setup**: README's `Chart setup` section leads with a TradingView "Share layout" link (`https://cn.tradingview.com/chart/sfPJCGOU/?symbol=USAR`). New users import once; everyone sees identical indicators (EMA 20/50/100/200 multi-period as 1 indicator + VWAP session = 2 indicators total → fits even TradingView Basic free tier), identical timezone (NY), identical candle coloring (close-vs-open standard), no community Ideas overlays.
- **If the layout is ever changed**: re-share from TradingView, update the URL in README. No code change needed.
- **i18n**: validation messages in both `en` and `zh` now name TradingView explicitly (`validatingDetail`, `validationFailedChart`, `notifyChartNotDetectedTitle/Body`, `monitoringStoppedChart`, `notifyCurrentTabNotChart`).
- **Tests**: `test/chart-validator.test.js` covers `tradingview.com`, `cn.tradingview.com`, subdomain matching, rejection of non-TV platforms (Yahoo / 雪球 / 富途 / generic blogs), and bilingual rejection reasons. 7 cases.

### Design decisions worth preserving
- **One trade per day, manual Continue to start a second**: chosen over auto-resume because the manual click is a natural cool-off period. Do not add an "allow multi-trade per day" toggle without first getting real evidence that multi-trading does not dilute edge; otherwise the toggle will become a foot-gun.
- **Overnight positions auto-abandoned without asking**: day-trading by definition cannot hold overnight, so resurrecting a cross-day position is never the right answer. No confirmation dialog — the `status: "abandoned"` journal entry preserves the audit trail.
- **No ad-hoc STATUS flags**: mode (entry/exit/force_exit) is derived from `virtualPosition` presence + `isNearUsMarketClose()`, not stored. This keeps the STATUS state machine (`IDLE`/`VALIDATING`/`AWAITING_CONTEXT`/`RUNNING`/`PAUSED`) as the single source of truth per original design.
- **Broker state is explicit after any reset**: Exit, monitored-tab close, Chrome startup, and extension reload clear active plugin state even if `virtualPosition` or `pendingLimitOrder` existed. This is intentional simplification: the broker is the source of truth, and the next session asks the user to explicitly declare whether they already hold the stock after completing Market Context Scan. Do not re-add automatic recovery/rebind without first revisiting the product complexity tradeoff.

## Rejected (do not re-propose)
- #1 Changing the model name — `gpt-5.4` is verified to work; user uses it intentionally
- #7 Compressing screenshots — user prefers high-resolution captures for chart accuracy
- #13 Encrypting the API key in storage — single-user local tool, not worth the complexity
- Stage D / paper-trading mode / 30-day simulated stats — user decided not to build it
- Auto multi-trade per day — current manual Continue is the cool-off period; revisit only with real evidence that multi-trading doesn't dilute edge
- Compression / batching of `tradeHistory` for older entries — premature optimization until user hits the 500-trade cap

## Conventions
- User writes in Chinese; respond in Chinese.
- All new user-visible or log strings go through `t(language, key)` in `lib/i18n.js` — do not inline literals.
- Keep the STATUS state machine (`IDLE` / `VALIDATING` / `AWAITING_CONTEXT` / `RUNNING` / `PAUSED`) as the single source of truth; don't add ad-hoc flags.
- Don't add backwards-compat shims — single user, just change the code.
