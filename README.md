# Stock Chart Analyzer

A Chrome Extension (Manifest V3) that screenshots a stock chart every N seconds, sends it to OpenAI (vision + Structured Outputs, model `gpt-5.4`), and returns an executable day-trading recommendation in a side panel. Single-user local tool.

This is an execution assistant, not a fundamental screener. It assumes the user has already decided **which** stock to trade and only needs help with **when** to enter, hold, or exit during the session.

## What it does

- Captures the visible chart of the bound tab on a fixed interval (`chrome.alarms`).
- Sends each screenshot to OpenAI Responses API with a strict JSON schema and gets back one execution signal per round.
- Tracks a virtual position lifecycle (entry → hold → exit) inside the extension so the AI prompt is mode-aware.
- Logs each closed trade to a journal, generates an AI-written lesson, and feeds the last 10 lessons back into future prompts.
- Surfaces a real-trade performance stats card (win rate, avg PnL, breakdown by action and confidence) once trade history is non-empty.
- Optionally posts a Discord webhook notification when the action changes between rounds.
- Bilingual UI (English + Simplified Chinese), single source of truth in `lib/i18n.js`.

## Recommended chart setup

For best results prepare the chart like this before clicking Start:

- 5-minute candlestick chart
- EMA 20 / 50 / 100 / 200
- VWAP (session)
- Volume pane visible

The prompt instructs the model to use these only if visible and to never invent levels or relationships that are not on the screenshot.

## User flow

1. Open a stock-chart page (TradingView, Yahoo Finance, 雪球, 东方财富, 富途, 老虎, 新浪财经, etc.).
2. Open the popup. Save your OpenAI API key. Optionally save a Discord webhook URL. Optionally toggle "market hours only" (9:30–16:00 ET, Mon–Fri).
3. Click `Start` in the popup. The extension validates the tab.
4. The side panel opens with the session form. Fill in:
   - **Ticker symbol** (auto-guessed from title/URL when possible, but user input wins)
   - **Analysis interval** (e.g. every 60 / 90 / 120 seconds)
   - **Total rounds**
   - **Background notes** (optional, ≤ 500 chars — e.g. "stock at ATH, earnings tomorrow, sector risk-off")
   - **Long-term context** (optional — generate once from a Daily or Weekly chart, see below)
5. Click `Start Monitoring`. The first round fires immediately; subsequent rounds run on the alarm.
6. The recommendation card shows the latest signal. The session enters entry mode (looking for BUY) or exit mode (managing an open position) depending on whether you have marked a trade as filled.

### Trade lifecycle

Action vocabulary the AI is allowed to return:

| Mode | Allowed actions |
| --- | --- |
| Entry (no position) | `BUY_NOW`, `BUY_LIMIT`, `WAIT` |
| Exit (holding) | `SELL_NOW`, `SELL_LIMIT`, `HOLD` |
| Force-exit (10 min before close, holding) | `SELL_NOW` only |

Side panel buttons follow the signal:

- `BUY_NOW` / `BUY_LIMIT` → user marks the entry price after filling at the broker.
- `BUY_LIMIT` / `SELL_LIMIT` → user records the broker-placed limit price; the next round's prompt is told a resting order exists so the AI can stay consistent or explicitly invalidate it.
- `SELL_NOW` / `SELL_LIMIT` → user marks the exit price; the trade is closed, written to the journal, and the session pauses (one trade per day; manual Continue starts the next).
- Overnight gap → if a position is somehow still open when the trading day rolls over, it is auto-abandoned with `status: "abandoned"` in the journal.

## Recommendation schema

The model returns strict JSON with these fields:

- `action` — see vocabulary above
- `entryPrice` — for BUY_LIMIT, otherwise the reference price
- `stopLossPrice` — invalidation level
- `targetPrice` — profit target
- `triggerCondition` — short string describing the price/structure trigger ("close above $182.40 on 5m")
- `confidence` — `high` | `medium` | `low`
- `reasoning` — short rationale, must name specific structure / EMAs / VWAP / volume seen on the chart
- `symbol`
- `currentPrice`

## Prompt architecture (`lib/llm.js` + `lib/prompt-config.js`)

Single OpenAI call per round, language-aware (Chinese-mode output is generated in one shot — no separate translation step). Prompt is assembled from these sections, in order:

`[ROLE]` → `[OBJECTIVE]` → `[SESSION_MODE]` → `[POSITION_CONTEXT]` → `[CHART_CONTEXT]` → `[CHART_FOCUS]` → `[CHART_GUARDRAILS]` → `[ENTRY_MODE_RULES] | [EXIT_MODE_RULES] | [FORCE_EXIT_RULES]` → `[EXECUTION_RULES]` → `[OUTPUT_RULES]` → `[LANGUAGE_OUTPUT]` → `[RECENT_LESSONS]` → `[USER_CONTEXT]` → `[LONG_TERM_CONTEXT]` → `[LAST_SIGNAL_AND_ORDER]` → `[OUTPUT_FORMAT]`

Mode is derived (no ad-hoc flags): `virtualPosition === null && !nearClose` → entry; `virtualPosition !== null && !nearClose` → exit; `virtualPosition !== null && nearClose` → force-exit.

Notable injected sections:

- `RECENT_LESSONS` — last 10 closed trades with non-empty AI-generated lessons, formatted as `- [SYMBOL ±pnl% date] lesson`. Entry mode only.
- `USER_CONTEXT` — the per-session background notes the user typed, wrapped in `--- BEGIN NOTES --- / --- END NOTES ---` with an explicit anti-bias meta-rule: treat verifiable facts as true, treat user predictions / sentiment as USER BIAS, never let opinion override what the chart shows.
- `LONG_TERM_CONTEXT` — a structural read of the user's Daily or Weekly chart (trend, stage, key support/resistance, ≤300-char summary) generated once via a separate one-shot LLM call before the session starts. Anti-bias rules tell the AI: structural bias only, the 5-min chart is the trigger, on conflict lower confidence by one tier rather than letting the higher timeframe steamroll the intraday signal. A 24h staleness warning is included if the long-term snapshot is older than a day.
- `LAST_SIGNAL_AND_ORDER` — the prior round's action plus any resting limit order (action, price, age in minutes, full snapshot) so the next round either reuses the same numbers or explicitly flags invalidation in `reasoning`. Omitted in force-exit mode.

## State model

Single source of truth: `STATUS` enum (`IDLE` / `VALIDATING` / `AWAITING_CONTEXT` / `RUNNING` / `PAUSED`) plus four orthogonal data fields:

- `virtualPosition` — `null` when scanning for entry, `{ entryPrice, stopLossPrice, targetPrice, entryAction, entryConfidence, tradingDay, ... }` when holding.
- `pendingLimitOrder` — `null` or a snapshot of a resting BUY_LIMIT / SELL_LIMIT the user has placed at the broker.
- `monitoringProfile` — per-session config: `symbolOverride`, `analysisInterval`, `totalRounds`, `userContext`, `longTermContext`, …
- `tradeHistory` — closed (and abandoned) trades, capped at 500. Preserved across every reset path via `buildResetStatePreservingHistory()`.

Buttons:

- `Stop` — pauses; keeps profile, virtualPosition, pendingLimitOrder, tradeHistory.
- `Continue` — resumes a paused session on the original bound tab.
- `Restart` — round 1 with the same profile.
- `Exit` — clears the session (but `tradeHistory` is always preserved).

## Performance stats

Once any closed trade exists, a Performance Stats card renders in the side panel with overall win rate, avg PnL %, total PnL %, avg held minutes, best/worst trade, plus breakdowns by action (BUY_NOW vs BUY_LIMIT) and confidence (high / medium / low — calibration check). Buckets with `n < 5` show a "small sample" warning rather than being hidden — sparse buckets are still informative if flagged.

Pure aggregation lives in `lib/trade-stats.js` and is unit-tested.

## File layout

- `manifest.json`
- `background.js` — service worker; alarm-driven monitoring loop; tab binding; message routing; handlers for mark-bought / mark-sold / mark-limit-placed / mark-limit-cancelled / update-user-context / generate-long-term-context.
- `popup.html` / `popup.js` / `popup.css` — language, API key, Discord webhook, market-hours toggle, Start.
- `sidepanel.html` / `sidepanel.js` / `sidepanel.css` — session form, recommendation card, position card, limit-order card, background-notes editor, long-term context widget, trade journal, performance stats, recent rounds timeline.
- `offscreen.html` / `offscreen.js` — short audio cue when a fresh round lands.
- `lib/llm.js` — OpenAI calls (`callOpenAi` + `callOpenAiOnce` + retry wrapper with exponential backoff), prompt assembly, `generateTradeLesson`, `generateLongTermContext`.
- `lib/prompt-config.js` — execution prompt config + JSON schema + long-term prompt config.
- `lib/chart-validator.js` — keyword check that a tab is a stock chart page.
- `lib/symbol.js` — `guessSymbol` + `sanitizeUrl` (pure, unit-tested).
- `lib/market-hours.js` — `isWithinUsMarketHours`, `isNearUsMarketClose`, `getUsTradingDay` (pure, DST-correct via `Intl.DateTimeFormat`, unit-tested).
- `lib/side-panel.js` — side-panel availability helpers.
- `lib/storage.js`, `lib/constants.js` — state/settings helpers, `STATUS` enum, `createDefaultState()`, `buildResetStatePreservingHistory()`.
- `lib/trade-stats.js` — pure aggregator.
- `lib/i18n.js` — single dictionary for all user-facing + log strings (en + zh).
- `test/*.test.js` — 79 `node:test` cases (`npm test`).

## OpenAI setup

- Model: `gpt-5.4` (verified — do not "fix" it).
- Image input: high detail (no compression — full-resolution screenshots).
- Strict JSON schema output.
- Retry: 3 attempts, 1s/2s exponential backoff, retries network errors + HTTP 429/5xx + `incomplete: max_output_tokens`.
- Key stored in `chrome.storage.local` (single-user local tool — see Security below).

## Discord notifications

Optional. When a webhook URL is configured, the extension posts an embed **only when `action` differs from the previous round's action** — no per-round spam. Payload includes action, current price, entry/stop/target, confidence, reasoning, symbol.

## Market hours gate

Optional toggle in the popup. When on, scheduled rounds are skipped outside 9:30–16:00 ET, Mon–Fri. The skip reason is surfaced in the side panel summary while RUNNING so it is clear why no new card landed.

## Load locally in Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. `Load unpacked` → select this folder.
4. Open a stock-chart page (5-min candles, EMA 20/50/100/200, VWAP, volume pane).
5. Click the extension icon. Save API key. Optionally save Discord webhook + flip market-hours toggle.
6. Click Start. Fill the session form in the side panel. Click Start Monitoring.

> If you are working in a git worktree under `.claude/worktrees/<branch>/`, point `Load unpacked` at the worktree path, not the main repo root. Re-point after switching branches.

## Tests

```
npm test
```

`node:test` covers symbol parsing, chart validator, market hours / DST, trade-stats aggregation, and prompt assembly (mode awareness, RECENT_LESSONS, USER_CONTEXT, LONG_TERM_CONTEXT, LAST_SIGNAL_AND_ORDER, ordering invariants, anti-bias meta-rules).

## Security & limitations

- API key + Discord webhook live in `chrome.storage.local`. Acceptable for a single-user local tool; not a production secret-management model.
- Screenshot is `captureVisibleTab` — the chart tab must be in the foreground of the bound window when the alarm fires. If the user switches away, the round is captured of whatever is foregrounded, which is why the validator + tab binding exist.
- Not financial advice. Not for unattended live trading.
