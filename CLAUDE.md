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
- `lib/llm.js` — OpenAI calls (`callOpenAi` + `callOpenAiOnce` + retry wrapper), Market Context scan prompt, execution prompt assembly, review/lesson calls, analysis-output validation
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
- After Daily + 1H Market Context Scan, the side panel asks whether the user already holds the stock. If yes, the user enters the broker entry price and monitoring starts directly in exit mode; if flat, the optional premarket dip plan remains available in its 4:00-9:30 ET window.
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

Completed (Stage C — trade journal + human-review lessons):
- `markSold` persists closed trades to `state.tradeHistory` with `{ id, plannedStopLoss, plannedTarget, heldMinutes, lesson: null }`, then fires a background `generateTradeLesson` call that writes a ≤80-char lesson back by matching on `trade.id` (fire-and-forget; failures are swallowed so they cannot strand the session).
- `lib/llm.js` adds `generateTradeLesson` (separate OpenAI call with strict JSON schema, `LESSON_MAX_OUTPUT_TOKENS = 400`). Prompt instructs the model to name specific errors instead of generic praise.
- `RECENT_LESSONS` prompt injection was removed later. Lessons stay in the Trade Journal for human review only; they are not fed back into future analysis calls.
- Sidepanel gains a Trade Journal card rendering `tradeHistory` with win/loss tone + `Generating lesson...` placeholder until the async lesson lands.
- i18n keys added (en + zh): `tradeJournalTitle`, `tradeJournalCopy`, `noClosedTrades`, `lessonPending`.
- Tests include a regression asserting legacy `recentLessons` payloads are ignored by prompt assembly.

Completed (real-trade stats card):
- `MAX_TRADE_HISTORY = 500` decouples `tradeHistory` retention from `MAX_RESULTS` (20, which is still used for the per-round `results` timeline). See Known risks below.
- `virtualPosition` now captures `entryAction` + `entryConfidence` at `markBought` time; `markSold` copies them into the trade record. Legacy trades stay at `null` and fall into an "unknown" bucket that only renders when non-empty.
- `lib/trade-stats.js` is a pure aggregator: `computeTradeStats(tradeHistory)` → `{ overall, byConfidence }`. Filters `status:"abandoned"` and non-finite `pnlPercent`. Known confidence buckets (`high`/`medium`/`low`) are always present with `n:0` for stable UI rendering.
- Sidepanel Performance Stats card hides entirely when `overall.n === 0`. Buckets with `n < 5` render with a visible "small sample" warning — explicit choice to show-with-caveat rather than hide, since a 3-month run will still produce sparse confidence buckets and hiding them is worse than flagging them.
- i18n keys: `statsTitle`, `statsCopy`, `statsSmallSampleWarning`, `statsOverallHeading`, `statsByConfidenceHeading`, `statsSampleSize`, `statsWinRate`, `statsAvgPnl`, `statsTotalPnl`, `statsAvgHeld`, `statsBestTrade`, `statsWorstTrade`, `statsBucketEmpty`.
- Tests: 10 new cases in `test/trade-stats.test.js`. Suite: 58/58 green.
- This is **read-only aggregation of real-trade journal data**, not paper-trading simulation. Paper-trading / Stage D is not planned.

Completed (BUY_LIMIT/SELL_LIMIT unfilled-order tracking — combined A+B):
- **Problem**: AI suggests a limit order, user places it at the broker, next round fires before the limit fills. Without state, the next LLM call has no idea a resting order exists — it may contradict itself, or the user may silently skip a signal change.
- **Prompt side (approach A)**: New `LAST_SIGNAL_AND_ORDER` section in `lib/llm.js` (`formatLastSignalAndOrderSection`). When a `pendingLimitOrder` exists, tells the model "user has placed a BUY_LIMIT @ $X N minutes ago, still resting" + snapshot (entry/stop/target/confidence) + rules: reuse same numbers if still valid; explicitly flag invalidation in reasoning if not. When no pending order but a `lastSignal` exists, provides continuity context. **Omitted in `force_exit` mode** — action is locked to SELL_NOW, continuity is moot.
- **State side (approach B)**: New `state.pendingLimitOrder` field in `createDefaultState()`. Shape: `{ action, limitPrice, stopLossPrice, targetPrice, reasoning, confidence, symbol, placedAt, sourceRound }`. Orthogonal to `virtualPosition`: BUY_LIMIT pending + no position (entry mode); SELL_LIMIT pending + active position (exit mode). Cleared by `markBought` / `markSold` / `markLimitCancelled` / overnight abandon.
- **Handlers**: `markLimitPlaced(payload)` validates action ∈ {BUY_LIMIT, SELL_LIMIT}, position symmetry (BUY_LIMIT requires flat, SELL_LIMIT requires holding), no existing pending, price > 0. `markLimitCancelled()` is idempotent. Message routes: `mark-limit-placed`, `mark-limit-cancelled`.
- **markBought preference**: now copies `entryAction/entryConfidence` from the pending snapshot when available (falls back to `lastResult.analysis`) so stats attribution stays accurate even when the limit order fills rounds after the original signal.
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
- Sidepanel Trade Journal renders abandoned trades with `data-tone="abandoned"` (gray, 75% opacity) + `ABANDONED` badge + explanatory lesson text.
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

Completed (recommendation confidence color coding):
- `sidepanel.js` maps `analysis.confidence` to `data-tone="confidence-high|confidence-medium|confidence-low"` on the recommendation metric card. Unknown / malformed confidence stays neutral.
- `sidepanel.css` renders high confidence green, medium amber, and low red so signal quality is visible without reading the full rationale.
- UI-only change: prompt schema and stats aggregation remain unchanged (`confidence` is still `high | medium | low`).

Completed (performance stats action breakdown removal):
- Removed the Performance Stats "By Action" section because the limit-only action vocabulary leaves `BUY_LIMIT` as the only current entry action. Keeping `BUY_NOW` vs `BUY_LIMIT` buckets only surfaced legacy history and no longer helped calibration.
- `computeTradeStats()` now returns only `{ overall, byConfidence }`; the UI keeps the overall summary and confidence calibration table.

## Future work / not planned

### Known risks / follow-ups (small)
- `state.tradeHistory` now uses its own `MAX_TRADE_HISTORY = 500` (previously reused `MAX_RESULTS = 20`, which silently dropped journal entries after ~20 trades). Decoupled so months of history survive for human review + real-trade stats. 500 is not unbounded — if a user ever runs for multiple years, consider export-to-CSV + purge, or a separate `journalArchive`.
- `generateTradeLesson` is fire-and-forget with a swallowed catch. If the call fails (network / rate limit), the trade's `lesson` stays `null` forever — no retry, no backfill. Fine for now; revisit if many lessons end up stuck at null.
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
