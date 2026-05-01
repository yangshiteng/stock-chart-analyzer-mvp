# auto-stock

Chrome Extension (Manifest V3) that screenshots a TradingView chart every N seconds, sends it to OpenAI (vision + Structured Outputs) for an execution recommendation, and shows the result in a side panel. Locked to TradingView so the prompt can rely on a consistent chart layout. Single-user tool (not multi-tenant).

## Tech stack
- MV3 service worker (`background.js`) + offscreen document (`offscreen.js`) for audio
- Side panel UI (`sidepanel.html`/`sidepanel.js`) + popup (`popup.html`/`popup.js`)
- `chrome.alarms` for round scheduling, `chrome.storage.local` for state
- OpenAI Responses API, model `gpt-5.4` (verified to exist — do NOT "fix" it)
- i18n: English + Simplified Chinese, all strings in `lib/i18n.js`
- Optional Discord webhook notifications

## Key files
- `background.js` — service worker, monitoring loop, tab binding
- `lib/llm.js` — OpenAI calls (`callOpenAi` + `callOpenAiOnce` + retry wrapper)
- `lib/prompt-config.js` — execution prompt config + JSON schema
- `lib/chart-validator.js` — TradingView hostname check (extension is hard-locked to TradingView)
- `lib/symbol.js` — `guessSymbol` + `sanitizeUrl` (pure, unit-tested)
- `lib/market-hours.js` — `isWithinUsMarketHours` (pure, unit-tested, DST-correct)
- `lib/side-panel.js` — side-panel availability helpers (`shouldEnableSidePanelForTab`, `enableSidePanelForWindow`, `setSidePanelAvailabilityForTab`)
- `lib/storage.js`, `lib/constants.js` — state/settings helpers, STATUS enum
- `lib/i18n.js` — all user-facing + background-log strings (single source of truth)
- `sidepanel.js`, `popup.js`, `offscreen.js`
- `test/*.test.js` — `node:test` unit tests; run `npm test`

## IMPORTANT: loading the extension

This repo uses a git worktree at `.claude/worktrees/<branch>/`. Chrome's "Load unpacked" must point at whichever directory actually contains the edits you want to test.

- If working in a worktree: load unpacked from the worktree path, not the main repo root.
- After switching branches or worktrees: re-point "Load unpacked" and click reload.
- Symptom of wrong path: edits appear to have no effect, old behavior persists. Already burned a full debug session on this — verify the load path first before hunting bugs.

## Approved improvements — status

Completed (Batch 1):
- #2 onStartup monitoring recovery (restore alarm after browser restart)
- #3 Tab check only at screenshot moment; removed aggressive onActivated pause
- #12 Merged background `bgText` into `lib/i18n.js`; fixed same-line format bug
- #14 Simplified `shouldEnableSidePanelForTab` — side panel stays enabled for all tabs while RUNNING/PAUSED **(superseded — see "Side panel bound to original tab" below)**

Completed (Batch 2):
- #4 Symbol input (`symbolOverride`) in sidepanel + expanded chart-validator keywords (雪球/东方财富/富途/老虎/长桥/同花顺/新浪财经/seeking alpha/investing.com/barchart/stockcharts/finviz) + tightened `guessSymbol` (checks `$TSLA`, URL patterns, title-lead)
- #6 Merged Chinese translation into a single analysis call via a language-aware `LANGUAGE_OUTPUT` prompt section (translation round-trip removed)
- #8 Exponential backoff in `callOpenAi` (3 attempts, 1s/2s, retries only network errors + HTTP 429/5xx)
- #11 Deduped `callOpenAiJson` / `callOpenAiAnalysis` into one `callOpenAi` + `callOpenAiOnce` pair

Completed (Batch 3):
- #5 Discord notification fires only when `analysis.action` differs from previous round's action
- #9 Recent rounds timeline section in sidepanel (top 10 of `state.results`)
- #10 Market-hours gate (popup toggle `marketHoursOnly`, 9:30–16:00 ET Mon–Fri via `Intl.DateTimeFormat` so DST is correct)
- #15 Debounced sidepanel `render()` (100ms) and `currentShares` input handler (150ms); `storage.onChanged` filters to `local` + `monitorState`/`appSettings`

Completed (Batch 4):
- A1 Sidepanel summary now surfaces `stopReason` while still RUNNING (market-closed skip is visible)
- A2 Alarm handler guards against re-entry via `isRoundInFlight`; staleness timeout (3 min via `roundStartedAt`) prevents deadlock if the service worker is evicted mid-round
- A4 Raised `ANALYSIS_MAX_OUTPUT_TOKENS` to 1800 (Chinese merge made 1100 tight); `incomplete: max_output_tokens` now marked retryable; retry wrapper honors an explicit `error.retryable` flag
- C2 `sanitizeUrl()` strips query + fragment before sending page URL to OpenAI; `guessSymbol` also runs on the cleaned URL
- C4 `recoverMonitoringAfterStartup` clears a stale `isRoundInFlight: true` on service-worker cold start
- Non-blocking start: `startMonitoring` / `continueMonitoring` / `restartMonitoring` schedule the alarm and fire-and-forget the first round; sidepanel submit has an explicit `catch` so any `sendMessage` failure still re-renders instead of stranding the loading card

Completed (Batch 5.5 — tracked-but-already-done):
- C3 Timeline rows in sidepanel are colored by `data-action` (green BUY_*, red SELL_*, amber WAIT) — implemented in `sidepanel.css`, logged for audit trail.
- C7 `popup.html` API key input is already `type="password"` — no plaintext exposure. Logged for audit trail.

Completed (Stage B — virtual-position state machine + semi-auto flow):
- `state.virtualPosition` is the single signal for entry vs exit mode (null = scanning entry; object = holding, scanning exit). STATUS enum untouched per the "no ad-hoc flags" rule.
- `lib/llm.js` builds the JSON schema dynamically: entry allows `BUY_NOW/BUY_LIMIT/WAIT`; exit allows `SELL_NOW/SELL_LIMIT/HOLD`; force_exit locks to `SELL_NOW` only.
- Prompt adds `SESSION_MODE` + `POSITION_CONTEXT` sections and mode-specific rule blocks (`ENTRY_MODE_RULES` / `EXIT_MODE_RULES` / `FORCE_EXIT_RULES`).
- `lib/market-hours.js` exports `isNearUsMarketClose` (10-min lead before 16:00 ET, DST-safe). `runMonitoringRound` flips mode to `force_exit` when holding near close.
- New background handlers: `mark-bought` sets `virtualPosition`; `mark-sold` appends to `state.tradeHistory` and calls `pauseMonitoring` (session ends when flat).
- Sidepanel: position-summary card + mark-bought/mark-sold input forms appear based on `virtualPosition` + last action.

Completed (Stage C — trade journal + self-learning):
- `markSold` persists closed trades to `state.tradeHistory` with `{ id, plannedStopLoss, plannedTarget, heldMinutes, lesson: null }`, then fires a background `generateTradeLesson` call that writes a ≤80-char lesson back by matching on `trade.id` (fire-and-forget; failures are swallowed so they cannot strand the session).
- `lib/llm.js` adds `generateTradeLesson` (separate OpenAI call with strict JSON schema, `LESSON_MAX_OUTPUT_TOKENS = 400`). Prompt instructs the model to name specific errors instead of generic praise.
- Entry-mode prompts inject a `[RECENT_LESSONS]` section built from the last 10 trades with non-empty lessons (formatted as `- [SYMBOL ±pnl% date] lesson`). Omitted in exit/force_exit modes and when the list is empty.
- Sidepanel gains a Trade Journal card rendering `tradeHistory` with win/loss tone + `Generating lesson...` placeholder until the async lesson lands.
- i18n keys added (en + zh): `tradeJournalTitle`, `tradeJournalCopy`, `noClosedTrades`, `lessonPending`.
- Tests: 4 new cases in `test/llm.test.js` cover RECENT_LESSONS injection, exit-mode omission, empty-list omission, and blank-lesson filtering. Suite: 45/45 green.

Completed (real-trade stats card — Stage D prerequisite):
- `MAX_TRADE_HISTORY = 500` decouples `tradeHistory` retention from `MAX_RESULTS` (20, which is still used for the per-round `results` timeline). See Known risks below.
- `virtualPosition` now captures `entryAction` + `entryConfidence` at `markBought` time; `markSold` copies them into the trade record. Legacy trades stay at `null` and fall into an "unknown" bucket that only renders when non-empty.
- `lib/trade-stats.js` is a pure aggregator: `computeTradeStats(tradeHistory)` → `{ overall, byAction, byConfidence }`. Filters `status:"abandoned"` and non-finite `pnlPercent`. Known buckets (`BUY_NOW`/`BUY_LIMIT`, `high`/`medium`/`low`) are always present with `n:0` for stable UI rendering.
- Sidepanel Performance Stats card hides entirely when `overall.n === 0`. Buckets with `n < 5` render with a visible "small sample" warning — explicit choice to show-with-caveat rather than hide, since a 3-month run will still produce sparse confidence buckets and hiding them is worse than flagging them.
- i18n keys: `statsTitle`, `statsCopy`, `statsSmallSampleWarning`, `statsOverallHeading`, `statsByActionHeading`, `statsByConfidenceHeading`, `statsSampleSize`, `statsWinRate`, `statsAvgPnl`, `statsTotalPnl`, `statsAvgHeld`, `statsBestTrade`, `statsWorstTrade`, `statsBucketEmpty`.
- Tests: 10 new cases in `test/trade-stats.test.js`. Suite: 58/58 green.
- Intentionally scoped down from Stage D: this is **read-only aggregation of real-trade journal data**, not paper-trading simulation. Stage D adds auto-execution on top; this card is the measurement layer that tells us whether Stage D is even worth building.

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
- `abandonStaleVirtualPositionIfNeeded()` runs on `chrome.runtime.onStartup` (before `recoverMonitoringAfterStartup`) and at the start of every `runMonitoringRound`. If the stored `tradingDay !== today`, the position is cleared, an `{ status: "abandoned", abandonReason: "overnight_gap" }` record is appended to `tradeHistory`, and the session is paused with i18n reason `sessionAbandonedOvernight`.
- Sidepanel Trade Journal renders abandoned trades with `data-tone="abandoned"` (gray, 75% opacity) + `ABANDONED` badge + explanatory lesson text.
- Design choice: no user confirmation — per day-trading rule, any cross-day position is invalid by definition. Prevents the "stale ghost position" scenario from power loss / lid-close / Chrome crash.

Completed (VWAP + Volume signal gating in execution prompt):
- **Problem**: prompt told the AI to read price + EMAs but never explicitly named VWAP or volume confirmation, so signals would fire on price-only structure even when volume contradicted (e.g. breakout on no participation).
- **Solution**: extended `lib/prompt-config.js` so VWAP and Volume are first-class focus areas, not optional chart furniture. `chartFocusAreas` now lists "VWAP relationship (price above/below, recent reclaims/rejections)" and "Volume pane (current bar vs prior, expansion/contraction at the level)". `chartGuardrails` adds "do not assume VWAP/Volume are present — only reference them if visible". `executionRules` requires the model to cite at least one of {VWAP, Volume, EMA stack, structural level} in `reasoning` rather than vague "looks bullish" copy.
- **UI**: chart-setup reminder updated in `lib/i18n.js` (en + zh) to include VWAP and Volume alongside EMA 20/50/100/200, since the model can only use what the user actually puts on the chart.
- **Tests**: new case in `test/llm.test.js` ("buildAnalysisPromptFromConfig: prompt teaches AI to use Volume + VWAP") asserts both keywords appear in the assembled prompt and that the guardrail "only if visible" wording is present.
- **Design note**: deliberately kept as prompt-side gating, not schema-side. Adding `volumeConfirmed: boolean` to the JSON schema would invite the model to confidently fill in `true` even when no volume pane is visible. Keeping it in `reasoning` text means the user can spot-check what the model actually saw.

Completed (long-term context — separate one-shot LLM call + structural anti-bias):
- **Problem**: 5-min chart alone is myopic. Same setup at $50 in a multi-month base vs $50 at the top of a parabolic run is a completely different trade, and the intraday model has no way to know which one it is.
- **Solution**: before the session starts, the user generates a one-shot read of a Daily or Weekly chart. That read is cached on `monitoringProfile.longTermContext` and injected into every 5-min prompt for the rest of the session. **No per-round refresh** — long-term structure does not change minute to minute, and re-fetching would burn tokens for no information gain.
- **State**: pre-session staging via `state.longTermContextDraft: null` (added to `createDefaultState()`). `startMonitoring` reads the draft, copies it onto the new `monitoringProfile.longTermContext`, then clears the draft. Means: long-term context is **frozen for the entire session**. To refresh, Exit and start a new session — chosen over a mid-session re-generate button because each new session is already a natural moment to re-evaluate.
- **Separate prompt + schema**: `LONG_TERM_PROMPT_CONFIG` + `LONG_TERM_RESPONSE_SCHEMA` in `lib/prompt-config.js`; `generateLongTermContext(payload)` in `lib/llm.js` runs a separate one-shot call (`LONG_TERM_MAX_OUTPUT_TOKENS = 700`). Output: `{ timeframe, summary (≤300 chars), trend ∈ {up,down,range,unclear}, stage ∈ {base,breakout,extended,pullback,topping,reversal,unclear}, keySupport, keyResistance, symbol, generatedAt }`. The long-term role is **structural reader, not signal generator** — explicitly forbidden from emitting trade actions.
- **Injection**: `formatLongTermContextSection` outputs `[LONG_TERM_CONTEXT]` placed BEFORE `formatLastSignalAndOrderSection` — ordering locked by a unit test. (Originally also placed AFTER the now-removed `formatUserContextSection`; that constraint became moot when user-context notes were deleted.) Included in **all three modes** (entry/exit/force_exit) since structural context matters for hold/exit decisions too. 24h staleness warning auto-injected when `now - generatedAt > 24h`.
- **Anti-bias rules** (the non-negotiable part): the section ends with explicit instructions: (a) treat the long-term read as **structural bias only**, never as a trade signal; (b) the 5-min chart is the **trigger**, the long-term read is just **context for sizing/confidence**; (c) on conflict, do **not** let long-term bullishness override what the 5-min shows — instead, lower confidence by one tier (`high → medium`, `medium → low`); (d) name the long-term read in `reasoning` only when it actually influenced the decision. Without these rules, a "long-term uptrend" tag would steamroll every bearish intraday setup, which is exactly the calibration failure we are trying to avoid.
- **UI**: optional widget inside the start-monitoring form. Timeframe select (Daily/Weekly) + Generate button → captures the active tab → calls `generateLongTermContext` → renders trend/stage/support/resistance/summary back into the form. Once monitoring is RUNNING the long-term read is read-only; refresh = Exit + new session.
  - **Pivot history**: originally implemented with TWO entry points (start form + a running-card widget that allowed mid-session re-generate / clear). User then reconsidered and asked to remove the running-card entry — kept only the form entry. Cleanup removed: HTML section, ~10 DOM refs, renderer, event handlers, the `clearLongTermContext` handler + message route, and 5 i18n keys (`longTermCopy`, `longTermRegenerateButton`, `longTermClearButton`, `longTermStaleWarning`, `longTermNotEditableWhilePaused`). The simpler "frozen per session" semantics is the intended end state — do not re-add the running-card entry without a clear reason.
- **i18n**: en + zh keys for: `longTermTitle`, `longTermFormCopy`, `longTermTimeframeLabel`, `longTermTimeframe_daily/_weekly`, `longTermGenerateButton`, `longTermGenerating`, `longTermFieldTrend/Stage/Support/Resistance/Summary`, `longTermGeneratedAt`, `longTermGenerateFailed`, `longTermTrend_up/down/range/unclear`, `longTermStage_base/breakout/extended/pullback/topping/reversal/unclear`.
- **Tests**: 6 new cases in `test/llm.test.js` covering injection in entry/exit/force_exit, omission when null/empty, 24h staleness warning, no warning when fresh, and the ordering invariant (was `USER_CONTEXT < LONG_TERM_CONTEXT < LAST_SIGNAL_AND_ORDER`; simplified to `LONG_TERM_CONTEXT < LAST_SIGNAL_AND_ORDER` after the user-context removal). Suite: 79/79 green at the time.
- **Design note**: Daily + Weekly only — no Monthly. Rationale: day trader's planning horizon rarely extends past 1–3 weeks of structure; Monthly would mostly add noise + token cost. If a swing-trading mode is ever added, revisit then.

Completed (Side panel content per-tab — supersedes Batch 1 #14):
- **Problem**: with the original "enabled on every tab" behavior, switching to a non-TradingView tab (news article, email, broker) kept the recommendation card visible — implying the analysis still applied to whatever tab was on top.
- **First attempt (commit `6031120`, did not work)**: tried to make `setOptions({ enabled: false })` *hide* the panel on non-bound tabs. **Chrome MV3 doesn't actually close an open side panel that way.** The per-tab `enabled` flag controls toolbar-icon access and content path, but does NOT close a panel that's already open at the window level. There is **no `chrome.sidePanel.close()` API** — Chromium's deliberate design decision (panel is user-controlled). `window.close()` from inside the panel is also a no-op. So "hide on tab switch" is fundamentally not achievable; commit `6031120` shipped a fix that compiled and passed tests but did nothing visible in practice.
- **Final design**: keep the panel `enabled: true` on every tab during a live session, but **swap the `path`** based on which tab is active.
  - Bound tab → `sidepanel.html` (full UI: recommendation, position, journal, stats…)
  - Non-bound tabs → `sidepanel-other-tab.html` (minimal placeholder: title, "monitored tab: AAPL · TradingView", "Switch to monitored tab" button → `chrome.tabs.update(boundTabId, { active: true })` + `chrome.windows.update(boundWindowId, { focused: true })`)
- **Effect**: panel column always visible (we can't hide it), but content makes the binding obvious. User clicks the button → jumps to bound tab → Chrome's per-tab path updates → full UI re-appears automatically (this part of Chrome's behavior **does** work cleanly).
- **API shape**: new `getSidePanelConfigForTab(state, tabId, validation)` returns `{ enabled, path? }`. Old `shouldEnableSidePanelForTab` retained as a thin shim returning `.enabled` for any callers that only need the boolean. Note: with the new design the boolean is `true` for *both* bound and non-bound tabs during a live session — only the path differs. So if anything checks `enabled` to mean "should I render the full UI", it will be wrong; use `path === SIDEPANEL_PATH` instead.
- **Files added**: `sidepanel-other-tab.html`, `sidepanel-other-tab.js`. CSS rules (`.other-tab-shell`, `.other-tab-card`, etc.) appended to `sidepanel.css`. New `enableSidePanelForWindow` delegates to per-tab `setSidePanelAvailabilityForTab` so all tabs in the window get the right path immediately after Start / Continue / Restart, not just on subsequent activations.
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

## Future work (registered, not done)

### Stage D — paper-trading mode + 30-day stats dashboard
**Prerequisite**: 1–2 weeks of real live-mode usage first. Without a baseline dataset, paper-trading statistics are optimizing against noise.

Scope:
- `popup.html` adds a `tradingMode: "live" | "paper"` radio (default live). Stored in settings.
- Paper mode: `BUY_NOW`/`BUY_LIMIT` auto-creates a `virtualPosition` at the AI's `entryPrice`; next round reads `currentPrice` from the analysis output and auto-closes if price crosses `stopLossPrice` or `targetPrice`. No manual Mark bought / Mark sold buttons — fully hands-off.
- Paper trades go into `state.paperTradeHistory` (separate from `tradeHistory`) so real and simulated data never mix.
- New sidepanel stats card: rolling-30-day win rate, avg RR ratio, total PnL, breakdown by action (BUY_NOW vs BUY_LIMIT), breakdown by confidence (high/medium/low hit rates — calibration check).
- Yellow banner "🟡 PAPER TRADING MODE" at top of sidepanel while paper mode is active.
- Open design question: where does `currentPrice` come from? Options: (a) ask the LLM to report it each round (risk: hallucinated prices; add sanity check vs previous round), (b) call a separate quote API (more deps, rate limits). Start with (a) + sanity check.

Rationale: Stage D is the **verification layer** for Stages A/B/C — it answers "does this signal pipeline actually have positive expectancy?" Without it, every subsequent prompt tweak is subjective.

### Known risks / follow-ups (small)
- `state.tradeHistory` now uses its own `MAX_TRADE_HISTORY = 500` (previously reused `MAX_RESULTS = 20`, which silently dropped journal entries after ~20 trades). Decoupled so months of history survive for the RECENT_LESSONS loop + the upcoming real-trade stats card. 500 is not unbounded — if a user ever runs for multiple years, consider export-to-CSV + purge, or a separate `journalArchive`.
- `generateTradeLesson` is fire-and-forget with a swallowed catch. If the call fails (network / rate limit), the trade's `lesson` stays `null` forever — no retry, no backfill. Fine for now; revisit if many lessons end up stuck at null.
- `tradeHistory` is now preserved across every state reset via `buildResetStatePreservingHistory()` helper. Previously 6 code paths silently wiped the journal: `onInstalled` (reload/update), `exitMonitoring` (Exit button), `restartMonitoring` (Restart button), and 3 branches inside `runValidationPreflight` (fires on every Start click). That's why a fresh Start cleared months of journal. Other state fields (virtualPosition, pendingLimitOrder, monitoringProfile, results, …) still reset to defaults in all those paths — only tradeHistory is protected. If the shape of `tradeHistory` entries ever changes, add a one-off migration inside the helper — it's the single chokepoint for cross-version journal preservation. The only remaining raw `createDefaultState()` use is `onStartup`, guarded by `!state.updatedAt` (fires only on empty storage, nothing to preserve).
- No tab-activity freshness check: if user leaves the tab backgrounded for 30+ min, the screenshot still fires on schedule but the chart data may be stale. Currently ignored because users actively watching wouldn't hit this; worth revisiting if false signals correlate with tab-switch patterns.

### Hard-locked to TradingView (do not relax)
- `lib/chart-validator.js` is a **hostname check** against `tradingview.com` / `cn.tradingview.com` (and their subdomains). Multi-platform keyword matching (Yahoo, 雪球, 东方财富, 富途, 老虎, 长桥, 同花顺, 新浪, seeking alpha, investing.com, barchart, stockcharts, finviz, robinhood, webull, etrade, marketwatch) was deleted in this iteration — do **not** add platforms back without first re-discussing the prompt design.
- **Why**: predictable chart layout = stable screenshot grammar = consistent prompt input. The execution prompt and the recommended TradingView shared layout (linked from README) work together as one product surface.
- **One-click setup**: README's `Chart setup` section leads with a TradingView "Share layout" link (`https://cn.tradingview.com/chart/sfPJCGOU/?symbol=USAR`). New users import once; everyone sees identical indicators (EMA 20/50/100/200 multi-period as 1 indicator + VWAP session = 2 indicators total → fits even TradingView Basic free tier), identical timezone (NY), identical candle coloring (close-vs-open standard), no community Ideas overlays.
- **If the layout is ever changed**: re-share from TradingView, update the URL in README. No code change needed.
- **i18n**: validation messages in both `en` and `zh` now name TradingView explicitly (`validatingDetail`, `validationFailedChart`, `notifyChartNotDetectedTitle/Body`, `monitoringStoppedChart`, `notifyCurrentTabNotChart`).
- **Tests**: `test/chart-validator.test.js` covers `tradingview.com`, `cn.tradingview.com`, subdomain matching, rejection of non-TV platforms (Yahoo / 雪球 / 富途 / generic blogs), and bilingual rejection reasons. 7 cases.

### Design decisions worth preserving
- **One trade per day, manual Continue to start a second**: chosen over auto-resume because the manual click is a natural cool-off period. Do not add an "allow multi-trade per day" toggle without first getting Stage D win-rate data; if multi-trading dilutes edge, the toggle will become a foot-gun.
- **Overnight positions auto-abandoned without asking**: day-trading by definition cannot hold overnight, so resurrecting a cross-day position is never the right answer. No confirmation dialog — the `status: "abandoned"` journal entry preserves the audit trail.
- **No ad-hoc STATUS flags**: mode (entry/exit/force_exit) is derived from `virtualPosition` presence + `isNearUsMarketClose()`, not stored. This keeps the STATUS state machine (`IDLE`/`VALIDATING`/`AWAITING_CONTEXT`/`RUNNING`/`PAUSED`) as the single source of truth per original design.
- **Exit and Restart are blocked while `virtualPosition` or `pendingLimitOrder` is non-null**: tearing down the session would clear those fields, but the user still has a real position / resting order at the broker. The next AI round would (incorrectly) treat the user as flat and could issue another BUY. Blocking the button forces the user to resolve via Mark sold / Cancel limit first. Stop is still allowed — it preserves all state for Continue. UI greys out the buttons with a tooltip; backend `exitMonitoring` and `restartMonitoring` also throw if either field is non-null (defense in depth). Considered a confirmation dialog instead but rejected — destructive-confirmation dialogs trained users to click through them; a hard block is the only thing that reliably prevents the double-position bug.

## Rejected (do not re-propose)
- #1 Changing the model name — `gpt-5.4` is verified to work; user uses it intentionally
- #7 Compressing screenshots — user prefers high-resolution captures for chart accuracy
- #13 Encrypting the API key in storage — single-user local tool, not worth the complexity
- Auto multi-trade per day — current manual Continue is the cool-off period; revisit only after Stage D shows multi-trading doesn't dilute edge
- Compression / batching of `tradeHistory` for older entries — premature optimization until user hits the 50-trade cap

## Conventions
- User writes in Chinese; respond in Chinese.
- All new user-visible or log strings go through `t(language, key)` in `lib/i18n.js` — do not inline literals.
- Keep the STATUS state machine (`IDLE` / `VALIDATING` / `AWAITING_CONTEXT` / `RUNNING` / `PAUSED`) as the single source of truth; don't add ad-hoc flags.
- Don't add backwards-compat shims — single user, just change the code.
