# Stock Chart Analyzer

A Chrome Extension (Manifest V3) that screenshots a TradingView chart on a configurable 1 / 2 / 5 / 10 / 15 / 30 minute cadence, sends it to OpenAI (vision + Structured Outputs, model `gpt-5.4`), and returns an executable day-trading recommendation in a side panel. Single-user local tool, locked to TradingView so the prompt can rely on a consistent chart layout across users.

This is an execution assistant, not a fundamental screener. It assumes the user has already decided **which** stock to trade and only needs help with **when** to enter, hold, or exit during the session.

## What it does

- Captures the visible chart of the bound tab on a fixed interval (`chrome.alarms`).
- Sends each screenshot to OpenAI Responses API with a strict JSON schema and gets back one execution signal per round.
- Requires a pre-session Market Context Scan (Daily + 1H TradingView screenshots) so 5-minute entries know the higher-timeframe regime and key support / resistance levels.
- Tracks a virtual position lifecycle (entry → hold → exit) inside the extension so the AI prompt is mode-aware.
- Logs each closed trade to a journal and generates an AI-written lesson for human review.
- Surfaces a real-trade performance stats card (win rate, avg PnL, and confidence calibration) once trade history is non-empty.
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

### Market Context Scan setup

Before 5-minute monitoring starts, the side panel requires two higher-timeframe screenshots:

1. **Daily / 1D**: show roughly **3-6 months**. Keep candlesticks, Volume, and EMA 20 / 50 / 100 / 200 visible. Temporarily hide session VWAP, because it is not useful on a Daily chart. Hide TradingView visible-range High / Low labels; they are only the high/low of the current viewport and can be misleading.
2. **1H / 60m**: show roughly **5-20 trading days**. Keep candlesticks, Volume, and EMA 20 / 50 / 100 / 200 visible. VWAP is optional here and should be treated as secondary context. Hide visible-range High / Low labels here too.

The scan extracts `regime` (`uptrend` / `range` / `downtrend`), an aggression profile, a dip-buy policy, profit-taking style, and up to 10 key levels classified by type and strength.

## User flow

1. Open a TradingView chart for the ticker you want to trade. The extension only supports TradingView — see Chart setup above for the recommended layout.
2. Open the popup. Save your OpenAI API key. Optionally save a Discord webhook URL.
3. Click `Start Monitoring` in the popup. The extension validates the tab.
4. The side panel opens with the session form. Fill in:
   - **Ticker symbol** (auto-guessed from title/URL when possible, but user input wins)
   - **Entry / pending-order / position scan frequency**
   - **Quick-profit dollar delta** (stop-loss is chart-based — the AI returns its own `stopLossPrice` each round; place a hard stop at the broker if you want a fixed dollar cap)
5. Click `Start Monitoring`. The side panel moves to the mandatory Market Context Scan.
6. Switch the TradingView chart to Daily / 1D and click `Scan Daily`, then switch to 1H / 60m and click `Scan 1H`.
7. Review the extracted context summary, declare whether you already hold the stock, and switch TradingView back to the 5-minute chart.
8. If already holding, enter the broker entry price; the premarket dip plan is skipped and the first round starts in exit mode. If flat, the optional premarket dip plan is available only from 4:00-9:30 ET.
9. Click `Start Monitoring`. The first 5-minute round fires immediately if the regular session is open; otherwise monitoring waits and retries on the selected cadence. Monitoring continues until the user pauses/stops it or the regular session ends at 16:00 ET.
10. The recommendation card shows the latest signal. The session enters entry mode (looking for BUY) or exit mode (managing an open position) depending on the declared/recorded position state.

### Trade lifecycle

Action vocabulary the AI is allowed to return:

| Mode | Allowed actions |
| --- | --- |
| Entry (no position) | `BUY_LIMIT`, `WAIT` |
| Exit (holding) | `SELL_NOW`, `SELL_LIMIT`, `HOLD` |
| Force-exit (10 min before close, holding) | `SELL_NOW` only |

Entries are limit-only. In exit mode, `SELL_NOW` is allowed for immediate scalp profit, stop-loss, or capital protection; `SELL_LIMIT` is reserved for a take-profit limit above current price.

Side panel buttons follow the signal:

- `BUY_LIMIT` / `SELL_LIMIT` → user records the broker-placed limit price ("Mark limit placed"). The next round's prompt is told a resting order exists so the AI can stay consistent or explicitly invalidate it. When the broker reports the limit as filled, the user clicks "Limit filled" — the extension promotes it to a real position (BUY_LIMIT) or closes the existing position (SELL_LIMIT) using the limit price.
- `SELL_NOW` → user marks the actual fill price after exiting immediately in the broker. The trade is closed, written to the journal, and the session pauses; manual Continue starts the next scan.
- Manual override → if you exit early at market for any reason (panic close, fundamental news, broker rejected the limit), the position card shows a "Mark sold at this price" form pre-filled with `currentPrice`, available whenever you're holding regardless of the AI's current action.
- Overnight gap → if a position is somehow still open when the trading day rolls over, it is auto-abandoned with `status: "abandoned"` in the journal.

## Recommendation schema

The model returns strict JSON with these fields:

- `action` — see vocabulary above
- `orderPrice` — the exact broker order price to place now for `BUY_LIMIT` / `SELL_LIMIT`; `null` for `WAIT`, `HOLD`, and usually `SELL_NOW`
- `entryPrice` — optional reference to the recorded entry price when already holding; not the primary execution price
- `stopLossPrice` — invalidation level
- `targetPrice` — profit target
- `confidence` — `high` | `medium` | `low`; rendered green / amber / red in the recommendation card
- `reasoning` — short rationale, must name specific structure / EMAs / VWAP / volume seen on the chart
- `symbol`
- `currentPrice`

## Prompt architecture (`lib/llm.js` + `lib/prompt-config.js`)

The pre-session Market Context Scan uses two separate vision calls (`analyzeMarketContextScan`) for Daily and 1H screenshots, then merges them into `state.marketContext.summary`.

The 5-minute execution loop uses a single OpenAI call per round, language-aware (Chinese-mode output is generated in one shot — no separate translation step). Prompt is assembled from these sections, in order:

`[ROLE]` → `[OBJECTIVE]` → `[SESSION_MODE]` → `[POSITION_CONTEXT]` → `[MARKET_CONTEXT]` → `[LAST_SIGNAL_AND_ORDER]` → `[CHART_CONTEXT]` → `[CHART_FOCUS]` → `[CHART_GUARDRAILS]` → `[ACTION_RULES]` → `[ENTRY_MODE_RULES] | [EXIT_MODE_RULES] | [FORCE_EXIT_RULES]` → `[EXECUTION_RULES]` → `[LANGUAGE_RULES]` → `[LANGUAGE_OUTPUT]` → `[OUTPUT_FORMAT]`

Mode is derived (no ad-hoc flags): `virtualPosition === null && !nearClose` → entry; `virtualPosition !== null && !nearClose` → exit; `virtualPosition !== null && nearClose` → force-exit.

Notable injected sections:

- `LAST_SIGNAL_AND_ORDER` — the prior round's action plus any resting limit order (action, price, age in minutes, full snapshot) so the next round either reuses the same numbers or explicitly flags invalidation in `reasoning`. Omitted in force-exit mode.
- `MARKET_CONTEXT` — mandatory same-symbol, same-trading-day Daily + 1H context. The prompt uses it as a higher-timeframe map for regime, support/resistance, dip-buy aggressiveness, and profit-taking style; the final action still must be executable from the current 5-minute screenshot.
- Post-response validation checks that the returned action is legal for the current mode, `BUY_LIMIT` / `SELL_LIMIT` include a positive decimal `orderPrice`, `WAIT` / `HOLD` keep `orderPrice` empty, and entry-mode long setups have stop < orderPrice < target with at least 1:1 reward-to-risk. Invalid analysis output gets one fresh model retry before the session pauses with the validation error.

Legacy optional Daily / Weekly long-term context was removed. The current design reintroduces higher-timeframe information only as a mandatory, structured Market Context Scan for intraday execution: Daily + 1H regime and key levels, not swing-trading thesis text.
Recent trade lessons are intentionally kept out of the prompt. They remain in the trade journal as human review material, not as model self-learning context.

## State model

Single source of truth: `STATUS` enum (`IDLE` / `VALIDATING` / `AWAITING_CONTEXT` / `RUNNING` / `PAUSED`) plus a versioned state object (`stateVersion`) and five orthogonal data fields:

- `virtualPosition` — `null` when scanning for entry, `{ entryPrice, stopLossPrice, targetPrice, entryAction, entryConfidence, tradingDay, ... }` when holding.
- `pendingLimitOrder` — `null` or a snapshot of a resting BUY_LIMIT / SELL_LIMIT the user has placed at the broker.
- `marketContext` — mandatory pre-session context tied to `symbol` + US trading day. Contains Daily scan, 1H scan, and merged summary; invalid/missing context forces `AWAITING_CONTEXT`.
- `monitoringProfile` — per-session config: `symbolOverride`, state-specific scan intervals, sell-strategy deltas, bound tab/window metadata.
- `tradeHistory` — closed (and abandoned) trades, capped at 500. Preserved across every reset path via `buildResetStatePreservingHistory()`.

Stored monitor state is migrated through `migrateState()` in `lib/storage.js` before use. The migration chain through `STATE_VERSION = 10` removes legacy `userContext` / `longTermContext` / `longTermContextDraft` / `lastSignalReview` fields, resets pre-v5 market context, restores missing defaults, and caps large `results` / `tradeHistory` arrays to their configured limits. `tradeHistory` and `lastMonitoringProfile` are preserved.

Buttons:

- `Stop` — pauses; keeps profile, virtualPosition, pendingLimitOrder, tradeHistory.
- `Continue` — resumes a paused session on the original bound tab if Market Context is still valid for the same symbol + trading day; otherwise returns to Market Context Scan.
- `Exit` — clears the plugin session state and closes the side panel, while preserving `tradeHistory`. Broker positions/orders are not changed; the broker remains the source of truth.

Browser/tab close policy: closing the monitored TradingView tab or restarting Chrome clears active plugin session state. On the next run, the user must start from the setup flow again and explicitly declare any existing broker position by entering its entry price after Market Context Scan.

## Performance stats

Once any closed trade exists, a Performance Stats card renders in the side panel with overall win rate, avg PnL %, total PnL %, avg held minutes, best/worst trade, plus a confidence breakdown (high / medium / low — calibration check). Buckets with `n < 5` show a "small sample" warning rather than being hidden — sparse buckets are still informative if flagged.

Pure aggregation lives in `lib/trade-stats.js` and is unit-tested.

## File layout

- `manifest.json`
- `background.js` — service worker; alarm-driven monitoring loop; tab binding; message routing; handlers for mark-bought / mark-sold / mark-limit-placed / mark-limit-cancelled.
- `popup.html` / `popup.js` / `popup.css` — language, API key, Discord webhook, Start.
- `sidepanel.html` / `sidepanel-other-tab.html` / `sidepanel.js` / `sidepanel.css` — session form, recommendation card, confidence coloring, position card, limit-order card, trade journal, performance stats, recent rounds timeline, and the non-bound-tab placeholder.
- `offscreen.html` / `offscreen.js` — short audio cue when a fresh round lands.
- `lib/llm.js` — OpenAI calls (`callOpenAi` + `callOpenAiOnce` + retry wrapper), Market Context scan prompt, execution prompt assembly, review/lesson calls, analysis-output validation.
- `lib/market-context.js` — Market Context state helpers, same-day/same-symbol validity, Daily + 1H merge policy, key-level dedupe.
- `lib/prompt-config.js` — execution prompt config + JSON schema.
- `lib/chart-validator.js` — TradingView hostname check (the extension only supports TradingView).
- `lib/symbol.js` — `guessSymbol` + `sanitizeUrl` (pure, unit-tested).
- `lib/market-hours.js` — `isWithinUsMarketHours`, `isNearUsMarketClose`, `getUsTradingDay` (pure, DST-correct via `Intl.DateTimeFormat`, unit-tested).
- `lib/side-panel.js` — side-panel availability helpers.
- `lib/storage.js`, `lib/constants.js` — state/settings helpers, `STATUS` enum, `STATE_VERSION`, `createDefaultState()`, `migrateState()`, `buildResetStatePreservingHistory()`.
- `lib/trade-stats.js` — pure aggregator.
- `lib/i18n.js` — single dictionary for all user-facing + log strings (en + zh).
- `test/*.test.js` — 144 `node:test` cases (`npm test`).
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

## Market Hours

5-minute monitoring is always limited to the US regular session (9:30–16:00 ET, Mon–Fri). Before 9:30 ET the session stays armed and retries on the selected cadence; after 16:00 ET it pauses automatically.

## Load locally in Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. `Load unpacked` → select this folder.
4. Open a TradingView chart (import the [recommended layout](https://cn.tradingview.com/chart/sfPJCGOU/?symbol=USAR) for one-click setup).
5. Click the extension icon. Save API key. Optionally save a Discord webhook.
6. Click Start. Fill the session form in the side panel. Click Start Monitoring, complete Daily + 1H Market Context Scan, then start 5-minute monitoring.

> If you are working in a git worktree under `.claude/worktrees/<branch>/`, point `Load unpacked` at the worktree path, not the main repo root. Re-point after switching branches.

## Tests

```
npm test
```

`npm run lint` syntax-checks every JS/MJS file with `node --check`. `npm run check` runs lint + tests.

`node:test` covers symbol parsing, chart validator, market hours / DST, storage migration, Market Context merge/validity, trade-stats aggregation, prompt assembly (mode awareness, MARKET_CONTEXT, LAST_SIGNAL_AND_ORDER, ordering invariants), USER_CONTEXT / LONG_TERM_CONTEXT / RECENT_LESSONS removal regressions, review prompt assembly, and analysis-output validation.

GitHub Actions runs the same lint + test suite on every push and pull request via `.github/workflows/ci.yml`.

## Security & limitations

- API key + Discord webhook live in `chrome.storage.local`. Acceptable for a single-user local tool; not a production secret-management model.
- Screenshot is `captureVisibleTab` — the chart tab must be in the foreground of the bound window when the alarm fires. If the user switches away, the round is captured of whatever is foregrounded, which is why the validator + tab binding exist.
- Not financial advice. Not for unattended live trading.
