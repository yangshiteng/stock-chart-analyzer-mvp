# Stock Chart Analyzer MVP

A Chrome Extension (Manifest V3) MVP that validates stock-chart pages, captures visible chart screenshots, sends them to OpenAI `gpt-5.4`, and returns execution-oriented recommendations in a side panel.

## What It Does Now

Current implemented behavior:

- popup UI with:
  - language selector
  - OpenAI API key save / clear controls
  - Discord webhook URL save / clear controls
  - a single primary `Start` button
  - a chart setup reminder: use a `5-minute candlestick chart` with `EMA 20 / 50 / 100 / 200`
- side panel workflow with:
  - validation status
  - trading settings form
  - chart setup reminder
  - per-round loading state while a new screenshot analysis is in flight
  - compact recommendation card focused on execution guidance
  - `Stop`, `Continue`, `Restart`, and `Exit` controls
- screenshot capture of the active chart tab in the bound monitoring window
- keyword-based stock-chart validation from page title and URL
- OpenAI Responses API integration with `gpt-5.4`
- recurring monitoring using a user-selected analysis interval and total rounds
- Discord notifications for each successful recommendation round when a webhook is configured
- a short audio cue when a fresh recommendation result arrives
- automatic pause if the user leaves the original bound chart tab inside the monitored window
- automatic pause instead of full session loss when a single screenshot-analysis round fails
- bilingual UI strings for English and Simplified Chinese

## Recommended Chart Setup

For best results, users should prepare the chart like this:

- `5-minute candlestick chart`
- `EMA 20`
- `EMA 50`
- `EMA 100`
- `EMA 200`

The current prompt assumes those elements may be visible and avoids inferring EMA relationships that are not actually shown in the screenshot.

## Current User Flow

1. Open a stock-chart page.
2. Open the popup.
3. Choose a language if needed.
4. Save an OpenAI API key in the popup if one is not already stored.
5. Optionally save a Discord webhook URL in the popup if you want Discord alerts.
6. Click `Start`.
7. The extension validates the current tab.
8. If validation passes, the side panel opens and shows the trading settings form.
9. The user fills in:
   - `Current Shares`
   - `Average Cost`
   - `Available Cash`
   - `Buy Risk Style`
   - `Sell Risk Style`
   - `Analysis Interval`
   - `Total Rounds`
10. The extension starts monitoring and immediately runs the first round.
11. Later rounds run with `chrome.alarms` using the selected interval.
12. While a new round is running, the side panel shows a loading state instead of silently jumping to the next result.
13. Monitoring remains bound to the original chart tab.
14. If the user leaves that tab inside the monitored Chrome window, monitoring pauses instead of silently switching to another page.
15. Each successful round can also send a Discord notification if a webhook URL is configured.
16. Each successful round also plays a short result sound inside Chrome.
17. If one round fails because of an OpenAI or capture issue, the session pauses and keeps the current setup instead of clearing everything.
18. The user can resume from that paused state after checking the chart tab.
19. The user can:
   - `Stop`: pause the session and keep the current setup
   - `Continue`: resume a paused session on the original chart tab
   - `Restart`: restart monitoring from round 1 using the saved setup
   - `Exit`: fully clear the current monitoring session and close the side panel

## Recommendation Logic

The extension no longer asks the user to choose `Buy`, `Sell`, or a manual intent.

Instead, the user provides current trading context, and the model decides the best action right now from:

- `OPEN`
- `ADD_STRENGTH`
- `ADD_WEAKNESS`
- `HOLD`
- `REDUCE_PROFIT`
- `REDUCE_RISK`
- `EXIT`
- `WAIT`

The goal is to make the extension behave like an execution assistant rather than a manual intent picker.

## Prompt and Language Architecture

The prompt system is split into two stages:

1. English analysis
2. Optional Chinese translation

Current behavior:

- the main analysis prompt is always English
- the JSON schema and enum values remain English
- English mode returns the analysis directly
- Chinese mode performs a second LLM call that translates only user-facing fields into Simplified Chinese

The main analysis prompt is now structured into sections:

- `[ROLE]`
- `[OBJECTIVE]`
- `[USER_CONTEXT]`
- `[CHART_CONTEXT]`
- `[CHART_FOCUS]`
- `[CHART_GUARDRAILS]`
- `[RISK_STYLE_RULE]`
- `[ACTION_RULES]`
- `[OUTPUT_RULES]`
- `[LANGUAGE_RULES]`
- `[OUTPUT_FORMAT]`

The translation prompt is also section-based and keeps:

- schema keys unchanged
- `action` unchanged
- raw prices and raw price zones unchanged

## Current Analysis Schema

The model is required to return strict JSON with these fields:

- `action`
- `sizeSuggestion`
- `whatToDoNow`
- `levels.invalidation`
- `supportLevels.primary`
- `supportLevels.secondary`
- `resistanceLevels.primary`
- `resistanceLevels.secondary`
- `riskNote`
- `symbol`
- `currentPrice`

Notes:

- `whatToDoNow` is the main natural-language instruction shown in the recommendation card
- `sizeSuggestion` is a user-facing sizing recommendation, not broker-connected execution
- `supportLevels` and `resistanceLevels` are short visible price references extracted from the current chart
- `levels.invalidation` is the downside risk trigger / caution price

## OpenAI Setup

The extension currently uses the OpenAI Responses API with:

- model: `gpt-5.4`
- image input: high detail
- strict JSON schema output

The OpenAI API key is stored in `chrome.storage.local` inside the extension.

Current UX:

- API key management lives in the popup
- the side panel hides the setup card when a key is already stored

## Discord Notifications

The extension can optionally send Discord notifications through a user-provided webhook URL.

Current behavior:

- the webhook URL is stored in `chrome.storage.local`
- the popup lets the user save or clear the webhook URL
- each successful recommendation round posts a Discord embed with:
  - action
  - current price
  - current support
  - current resistance
  - risk trigger
  - suggested size
  - risk note

The Discord payload is intentionally aligned with the compact side-panel result model.

Notes:

- Discord notifications are optional
- if no webhook is configured, the extension skips Discord delivery
- webhook URLs are secrets and should never be committed into the repository

## File Structure

- `manifest.json`: extension manifest and permissions
- `background.js`: service worker, scheduling, capture, state transitions, pause / resume logic, side panel enablement, Discord delivery
- `offscreen.html`, `offscreen.js`: offscreen audio document used to play a short result cue
- `popup.html`, `popup.js`, `popup.css`: popup UI for language, OpenAI API key setup, Discord webhook setup, chart guidance, and `Start`
- `sidepanel.html`, `sidepanel.js`, `sidepanel.css`: side panel UI, trading settings form, chart guidance, recommendation display, and monitoring controls
- `lib/constants.js`: shared constants and state enums
- `lib/storage.js`: local storage helpers for monitor state and app settings
- `lib/chart-validator.js`: keyword-based stock chart validation
- `lib/prompt-config.js`: structured English analysis prompt config
- `lib/llm.js`: OpenAI request logic, JSON parsing, English analysis, and Chinese translation step
- `lib/i18n.js`: UI translation dictionary and helpers
- `assets/icon-128.png`: extension icon
- `AGENTS.md`: project guidance for coding agents

## State Model

Primary states:

- `idle`
- `validating`
- `awaiting_context`
- `running`
- `paused`

Important behavior:

- `Start` in the popup triggers validation
- `Stop` in the side panel pauses, it does not fully exit
- `Exit` fully clears the current session
- `Continue` only resumes when the user is back on the original bound chart tab
- if a single monitoring round fails, the extension pauses and preserves the current session instead of resetting to `idle`

## Side Panel Availability

The side panel is not meant to be generally available on any stock-looking page.

Current rule:

- before `Start` is used, the extension should not expose the side panel workflow for that tab
- after validation passes, the validated tab can open the side panel
- while monitoring is `running` or `paused`, the side panel stays associated with the original bound chart tab

## Load Locally In Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this project folder
5. Open a stock-chart page
6. Click the extension icon
7. Save your OpenAI API key if needed
8. Save a Discord webhook URL if you want Discord alerts
9. Confirm the chart is a `5-minute candlestick chart` with `EMA 20 / 50 / 100 / 200`
10. Click `Start`
11. Fill in the trading settings in the side panel and start monitoring

## Current Prompt Design

The prompt is configured in `lib/prompt-config.js`.

Current prompt behavior:

- assumes the stock has already passed the user's separate fundamental screening
- focuses on a 5-minute chart
- uses EMA 20 / 50 / 100 / 200 only if they are visible in the screenshot
- takes the user's position, available cash, and buy/sell risk preferences into account
- returns a single best execution action right now
- returns a dedicated `whatToDoNow` field so the UI does not have to stitch together the main action copy
- returns visible `supportLevels` and `resistanceLevels`
- uses `Buy Risk Style` and `Sell Risk Style` to shape how patient or aggressive the execution recommendation should be
- allows both pullback entries and reclaim / breakout-hold entries when the chart clearly supports them
- keeps the response:
  - concise
  - direct
  - JSON-only
  - focused on beginner-friendly execution guidance

## Limitations

- The extension does not do image-native chart validation yet.
- It uses visible-tab screenshots, so it cannot keep analyzing a background tab that is no longer active.
- Discord notifications currently send on every successful round, not only on action changes.
- It is not financial advice.
- It is not suitable for unattended live trading or production brokerage automation.

## Security

- The current MVP stores the OpenAI API key in `chrome.storage.local`.
- Optional Discord webhook URLs are also stored in `chrome.storage.local`.
- That is acceptable for local testing, but not a production-grade secret-management model.
- Do not commit API keys, webhook URLs, tokens, or personal credentials into this repository.
- A stronger production design would route model access through a backend you control.
