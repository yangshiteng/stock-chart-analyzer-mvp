# auto-stock

Chrome Extension (Manifest V3) that screenshots a stock chart every N seconds, sends it to OpenAI (vision + Structured Outputs) for an execution recommendation, and shows the result in a side panel. Single-user tool (not multi-tenant).

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
- `lib/chart-validator.js` — heuristic check that a tab is a stock chart
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
- #14 Simplified `shouldEnableSidePanelForTab` — side panel stays enabled for all tabs while RUNNING/PAUSED

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

Completed (Stage B follow-up — overnight-gap auto-abandon):
- `virtualPosition` now carries `tradingDay` (US/Eastern YYYY-MM-DD) at `markBought` time.
- `lib/market-hours.js` exports `getUsTradingDay(now)`; DST-safe via `Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" })`.
- `abandonStaleVirtualPositionIfNeeded()` runs on `chrome.runtime.onStartup` (before `recoverMonitoringAfterStartup`) and at the start of every `runMonitoringRound`. If the stored `tradingDay !== today`, the position is cleared, an `{ status: "abandoned", abandonReason: "overnight_gap" }` record is appended to `tradeHistory`, and the session is paused with i18n reason `sessionAbandonedOvernight`.
- Sidepanel Trade Journal renders abandoned trades with `data-tone="abandoned"` (gray, 75% opacity) + `ABANDONED` badge + explanatory lesson text.
- Design choice: no user confirmation — per day-trading rule, any cross-day position is invalid by definition. Prevents the "stale ghost position" scenario from power loss / lid-close / Chrome crash.

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
- `chrome.runtime.onInstalled` resets the full monitorState (including `tradeHistory`) on every extension reload. For a user who actively uses the journal, losing history on each version bump is annoying. Consider preserving `tradeHistory` + `virtualPosition` across reinstalls once Stage D lands and the data becomes valuable.
- No tab-activity freshness check: if user leaves the tab backgrounded for 30+ min, the screenshot still fires on schedule but the chart data may be stale. Currently ignored because users actively watching wouldn't hit this; worth revisiting if false signals correlate with tab-switch patterns.

### Design decisions worth preserving
- **One trade per day, manual Continue to start a second**: chosen over auto-resume because the manual click is a natural cool-off period. Do not add an "allow multi-trade per day" toggle without first getting Stage D win-rate data; if multi-trading dilutes edge, the toggle will become a foot-gun.
- **Overnight positions auto-abandoned without asking**: day-trading by definition cannot hold overnight, so resurrecting a cross-day position is never the right answer. No confirmation dialog — the `status: "abandoned"` journal entry preserves the audit trail.
- **No ad-hoc STATUS flags**: mode (entry/exit/force_exit) is derived from `virtualPosition` presence + `isNearUsMarketClose()`, not stored. This keeps the STATUS state machine (`IDLE`/`VALIDATING`/`AWAITING_CONTEXT`/`RUNNING`/`PAUSED`) as the single source of truth per original design.

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
