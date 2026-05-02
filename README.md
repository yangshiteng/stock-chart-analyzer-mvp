# Stock Chart Analyzer

A Chrome Extension (Manifest V3) that screenshots a TradingView chart on a fixed 5 / 10 / 15 / 30 minute cadence, sends it to OpenAI (vision + Structured Outputs, model `gpt-5.4`), and returns an executable day-trading recommendation in a side panel. Single-user local tool, locked to TradingView so the prompt can rely on a consistent chart layout across users.

This is an execution assistant, not a fundamental screener. It assumes the user has already decided **which** stock to trade and only needs help with **when** to enter, hold, or exit during the session.

## What it does

- Captures the visible chart of the bound tab on a fixed interval (`chrome.alarms`).
- Sends each screenshot to OpenAI Responses API with a strict JSON schema and gets back one execution signal per round.
- Tracks a virtual position lifecycle (entry → hold → exit) inside the extension so the AI prompt is mode-aware.
- Logs each closed trade to a journal, generates an AI-written lesson, and feeds the last 10 lessons back into future prompts.
- Surfaces a real-trade performance stats card (win rate, avg PnL, breakdown by action and confidence) once trade history is non-empty.
- Color-codes the latest recommendation confidence (`high` = green, `medium` = amber, `low` = red) so weak signals are obvious at a glance.
- Optionally posts a Discord webhook notification when the action changes between rounds.
- Bilingual UI (English + Simplified Chinese), single source of truth in `lib/i18n.js`.

## Chart setup

**One-click setup**: [import the recommended TradingView layout](https://cn.tradingview.com/chart/sfPJCGOU/?symbol=USAR). Sign in to TradingView (a free account works), clone the layout into your own account, then switch tickers freely — every chart you open will already have the right indicators, timezone, and color theme.

The layout includes:

- 5-minute candlesticks + a multi-period EMA indicator (20 / 50 / 100 / 200) + VWAP (session) + Volume pane
- US/New York timezone, regular trading hours only, 24-hour time format, standard close-vs-open candle coloring
- No grid, no watermark, no community Ideas overlays

That is the minimum the AI needs and the maximum it can use. Adding RSI / MACD / drawn levels does not improve signal quality and only shrinks each candle.

### Manual setup (if you do not want to import)

The two indicators below fit even the TradingView free tier:

1. A single multi-period EMA indicator covering **20 / 50 / 100 / 200**.
2. **VWAP (session)**.

Then in chart Settings:

- **Uncheck** `K线颜色基于前一收盘价` / `Color bars based on previous close` so candles use the standard close-vs-open coloring (the AI assumes this convention).
- Under Events, **disable** `观点` / `Ideas`. Community-published BUY/SELL markers overlay the chart and the AI will read them as part of the screenshot — this is the single biggest source of prompt pollution.
- Session = `常规交易时间` / `Regular Trading Hours`. Timezone = `(UTC-4) New York`. Time format = 24-hour.

### Zoom level

Show roughly **1.5–2 trading sessions** of 5-min bars. Each candle should be at least ~8 pixels wide — compressed week-views and hyper-zoomed 30-minute slices both lose information the AI needs.

## User flow

1. Open a TradingView chart for the ticker you want to trade. The extension only supports TradingView — see Chart setup above for the recommended layout.
2. Open the popup. Save your OpenAI API key. Optionally save a Discord webhook URL. Optionally toggle "market hours only" (9:30–16:00 ET, Mon–Fri).
3. Click `Start` in the popup. The extension validates the tab.
4. The side panel opens with the session form. Fill in:
   - **Ticker symbol** (auto-guessed from title/URL when possible, but user input wins)
   - **Analysis interval** (5 / 10 / 15 / 30 minutes)
   - **Total rounds**
   - **Long-term context** (optional — generate once from a Daily or Weekly chart, see below)
5. Click `Start Monitoring`. The first round fires immediately; subsequent rounds run on the alarm.
6. The recommendation card shows the latest signal. The session enters entry mode (looking for BUY) or exit mode (managing an open position) depending on whether you have marked a trade as filled.

### Trade lifecycle

Action vocabulary the AI is allowed to return:

| Mode | Allowed actions |
| --- | --- |
| Entry (no position) | `BUY_LIMIT`, `WAIT` |
| Exit (holding) | `SELL_LIMIT`, `HOLD` |
| Force-exit (10 min before close, holding) | `SELL_NOW` only |

The tool is **limit-only by design** — all entries and normal exits go through limit orders so the user controls slippage and fill quality. `SELL_NOW` survives only as the safety net for force-exit (last 10 minutes before close, where the must-be-flat-by-close rule outweighs slippage concerns). If the AI sees a setup that would have been a market `BUY_NOW` / `SELL_NOW` under a market-order regime, it issues `BUY_LIMIT` / `SELL_LIMIT` with `limitPrice` at or fractionally past the current price — a marketable limit that fills on the next tick but with price protection.

Side panel buttons follow the signal:

- `BUY_LIMIT` / `SELL_LIMIT` → user records the broker-placed limit price ("Mark limit placed"). The next round's prompt is told a resting order exists so the AI can stay consistent or explicitly invalidate it. When the broker reports the limit as filled, the user clicks "Limit filled" — the extension promotes it to a real position (BUY_LIMIT) or closes the existing position (SELL_LIMIT) using the limit price.
- `SELL_NOW` (force-exit only) → user marks the actual fill price after exiting at market in the broker. The trade is closed, written to the journal, and the session pauses (one trade per day; manual Continue starts the next).
- Manual override → if you exit early at market for any reason (panic close, fundamental news, broker rejected the limit), the position card shows a "Mark sold at this price" form pre-filled with `currentPrice`, available whenever you're holding regardless of the AI's current action.
- Overnight gap → if a position is somehow still open when the trading day rolls over, it is auto-abandoned with `status: "abandoned"` in the journal.

## Recommendation schema

The model returns strict JSON with these fields:

- `action` — see vocabulary above
- `entryPrice` — for BUY_LIMIT, otherwise the reference price
- `stopLossPrice` — invalidation level
- `targetPrice` — profit target
- `triggerCondition` — short string describing the price/structure trigger ("close above $182.40 on 5m")
- `confidence` — `high` | `medium` | `low`; rendered green / amber / red in the recommendation card
- `reasoning` — short rationale, must name specific structure / EMAs / VWAP / volume seen on the chart
- `symbol`
- `currentPrice`

## Prompt architecture (`lib/llm.js` + `lib/prompt-config.js`)

Single OpenAI call per round, language-aware (Chinese-mode output is generated in one shot — no separate translation step). Prompt is assembled from these sections, in order:

`[ROLE]` → `[OBJECTIVE]` → `[SESSION_MODE]` → `[POSITION_CONTEXT]` → `[RECENT_LESSONS]` → `[LONG_TERM_CONTEXT]` → `[LAST_SIGNAL_AND_ORDER]` → `[CHART_CONTEXT]` → `[CHART_FOCUS]` → `[CHART_GUARDRAILS]` → `[ACTION_RULES]` → `[ENTRY_MODE_RULES] | [EXIT_MODE_RULES] | [FORCE_EXIT_RULES]` → `[EXECUTION_RULES]` → `[LANGUAGE_RULES]` → `[LANGUAGE_OUTPUT]` → `[OUTPUT_FORMAT]`

Mode is derived (no ad-hoc flags): `virtualPosition === null && !nearClose` → entry; `virtualPosition !== null && !nearClose` → exit; `virtualPosition !== null && nearClose` → force-exit.

Notable injected sections:

- `RECENT_LESSONS` — last 10 closed trades with non-empty AI-generated lessons, formatted as `- [SYMBOL ±pnl% date] lesson`. Entry mode only.
- `LONG_TERM_CONTEXT` — a structural read of the user's Daily or Weekly chart (trend, stage, key support/resistance, ≤300-char summary) generated once via a separate one-shot LLM call before the session starts. Anti-bias rules tell the AI: structural bias only, the 5-min chart is the trigger, on conflict lower confidence by one tier rather than letting the higher timeframe steamroll the intraday signal. A 24h staleness warning is included if the long-term snapshot is older than a day.
- `LAST_SIGNAL_AND_ORDER` — the prior round's action plus any resting limit order (action, price, age in minutes, full snapshot) so the next round either reuses the same numbers or explicitly flags invalidation in `reasoning`. Omitted in force-exit mode.
- Post-response validation checks that the returned action is legal for the current mode, all price fields are positive decimal prices, and entry-mode long setups have stop < entry < target with at least 1:1 reward-to-risk. Invalid analysis output gets one fresh model retry before the session pauses with the validation error.

## State model

Single source of truth: `STATUS` enum (`IDLE` / `VALIDATING` / `AWAITING_CONTEXT` / `RUNNING` / `PAUSED`) plus a versioned state object (`stateVersion`) and four orthogonal data fields:

- `virtualPosition` — `null` when scanning for entry, `{ entryPrice, stopLossPrice, targetPrice, entryAction, entryConfidence, tradingDay, ... }` when holding.
- `pendingLimitOrder` — `null` or a snapshot of a resting BUY_LIMIT / SELL_LIMIT the user has placed at the broker.
- `monitoringProfile` — per-session config: `symbolOverride`, `analysisInterval`, `totalRounds`, `longTermContext`, bound tab/window metadata.
- `tradeHistory` — closed (and abandoned) trades, capped at 500. Preserved across every reset path via `buildResetStatePreservingHistory()`.

Stored monitor state is migrated through `migrateState()` in `lib/storage.js` before use. Version 1 removes legacy `userContext` fields from saved profiles, restores missing defaults, and caps large `results` / `tradeHistory` arrays to their configured limits.

Buttons:

- `Stop` — pauses; keeps profile, virtualPosition, pendingLimitOrder, tradeHistory.
- `Continue` — resumes a paused session on the original bound tab.
- `Restart` — round 1 with the same profile. Disabled while a real position or resting limit order is still tracked.
- `Exit` — clears the session (but `tradeHistory` is always preserved). Disabled while a real position or resting limit order is still tracked.

## Performance stats

Once any closed trade exists, a Performance Stats card renders in the side panel with overall win rate, avg PnL %, total PnL %, avg held minutes, best/worst trade, plus breakdowns by entry action (`BUY_LIMIT` is the only current entry; legacy journal entries from before the limit-only refactor may still show `BUY_NOW`) and confidence (high / medium / low — calibration check). Buckets with `n < 5` show a "small sample" warning rather than being hidden — sparse buckets are still informative if flagged.

Pure aggregation lives in `lib/trade-stats.js` and is unit-tested.

## File layout

- `manifest.json`
- `background.js` — service worker; alarm-driven monitoring loop; tab binding; message routing; handlers for mark-bought / mark-sold / mark-limit-placed / mark-limit-cancelled / generate-long-term-context.
- `popup.html` / `popup.js` / `popup.css` — language, API key, Discord webhook, market-hours toggle, Start.
- `sidepanel.html` / `sidepanel-other-tab.html` / `sidepanel.js` / `sidepanel.css` — session form, recommendation card, confidence coloring, position card, limit-order card, long-term context widget, trade journal, performance stats, recent rounds timeline, and the non-bound-tab placeholder.
- `offscreen.html` / `offscreen.js` — short audio cue when a fresh round lands.
- `lib/llm.js` — OpenAI calls (`callOpenAi` + `callOpenAiOnce` + retry wrapper with exponential backoff), prompt assembly, `generateTradeLesson`, `generateLongTermContext`.
- `lib/prompt-config.js` — execution prompt config + JSON schema + long-term prompt config.
- `lib/chart-validator.js` — TradingView hostname check (the extension only supports TradingView).
- `lib/symbol.js` — `guessSymbol` + `sanitizeUrl` (pure, unit-tested).
- `lib/market-hours.js` — `isWithinUsMarketHours`, `isNearUsMarketClose`, `getUsTradingDay` (pure, DST-correct via `Intl.DateTimeFormat`, unit-tested).
- `lib/side-panel.js` — side-panel availability helpers.
- `lib/storage.js`, `lib/constants.js` — state/settings helpers, `STATUS` enum, `STATE_VERSION`, `createDefaultState()`, `migrateState()`, `buildResetStatePreservingHistory()`.
- `lib/trade-stats.js` — pure aggregator.
- `lib/i18n.js` — single dictionary for all user-facing + log strings (en + zh).
- `test/*.test.js` — 103 `node:test` cases (`npm test`).
- `scripts/run-tests.mjs`, `scripts/lint.mjs` — dependency-free local/CI verification helpers.

## OpenAI setup

- Model: `gpt-5.4` (verified — do not "fix" it).
- Image input: high detail (no compression — full-resolution screenshots).
- Strict JSON schema output.
- Retry: 3 attempts, 1s/2s exponential backoff, retries network errors + HTTP 429/5xx + `incomplete: max_output_tokens`.
- Analysis validation: one extra model retry if the structured JSON is internally invalid for the current mode or price geometry.
- Key stored in `chrome.storage.local` (single-user local tool — see Security below).

## Discord notifications

Optional. When a webhook URL is configured, the extension posts an embed **only when `action` differs from the previous round's action** — no per-round spam. Payload includes action, current price, entry/stop/target, confidence, reasoning, symbol.

## Market hours gate

Optional toggle in the popup. When on, scheduled rounds are skipped outside 9:30–16:00 ET, Mon–Fri. The skip reason is surfaced in the side panel summary while RUNNING so it is clear why no new card landed.

## Load locally in Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. `Load unpacked` → select this folder.
4. Open a TradingView chart (import the [recommended layout](https://cn.tradingview.com/chart/sfPJCGOU/?symbol=USAR) for one-click setup).
5. Click the extension icon. Save API key. Optionally save Discord webhook + flip market-hours toggle.
6. Click Start. Fill the session form in the side panel. Click Start Monitoring.

> If you are working in a git worktree under `.claude/worktrees/<branch>/`, point `Load unpacked` at the worktree path, not the main repo root. Re-point after switching branches.

## Tests

```
npm test
```

`npm run lint` syntax-checks every JS/MJS file with `node --check`. `npm run check` runs lint + tests.

`node:test` covers symbol parsing, chart validator, market hours / DST, storage migration, trade-stats aggregation, prompt assembly (mode awareness, RECENT_LESSONS, LONG_TERM_CONTEXT, LAST_SIGNAL_AND_ORDER, ordering invariants, anti-bias meta-rules), USER_CONTEXT removal regression, and analysis-output validation.

GitHub Actions runs the same lint + test suite on every push and pull request via `.github/workflows/ci.yml`.

## Security & limitations

- API key + Discord webhook live in `chrome.storage.local`. Acceptable for a single-user local tool; not a production secret-management model.
- Screenshot is `captureVisibleTab` — the chart tab must be in the foreground of the bound window when the alarm fires. If the user switches away, the round is captured of whatever is foregrounded, which is why the validator + tab binding exist.
- Not financial advice. Not for unattended live trading.
