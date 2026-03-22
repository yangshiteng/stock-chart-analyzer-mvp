# Stock Chart Analyzer MVP

A Chrome Extension (Manifest V3) MVP that:

- captures the current tab screenshot
- validates whether the page looks like a stock chart using keyword rules
- lets the user choose `Buy` or `Sell`
- collects simple position context from the user
- sends the screenshot plus prompt context to OpenAI `gpt-5.4`
- shows JSON results in the side panel
- repeats every 5 minutes with `chrome.alarms`
- stops after 70 rounds or when the user clicks `Stop`

## Current Status

This repo is a working MVP prototype.

What is real now:

- Chrome extension flow
- popup `Start` / `Stop`
- side panel UI
- screenshot capture
- keyword-based stock chart validation
- session context form for `Buy` / `Sell`
- OpenAI API integration with `gpt-5.4`
- recurring monitoring every 5 minutes
- auto-stop after 70 rounds
- notifications for stop / error cases

What is still basic:

- chart validation is keyword-based, not image-based
- API key is stored in extension local storage for MVP simplicity
- error handling is improved but still lightweight
- no automated tests yet

## File Structure

- `manifest.json`: extension manifest and permissions
- `background.js`: service worker, scheduling, capture, monitoring workflow
- `popup.html`, `popup.js`, `popup.css`: popup UI with `Start` / `Stop`
- `sidepanel.html`, `sidepanel.js`, `sidepanel.css`: side panel UI, API key setup, Buy/Sell flow, results
- `lib/constants.js`: shared constants and state enums
- `lib/storage.js`: local storage helpers for monitor state and app settings
- `lib/chart-validator.js`: keyword-based stock chart validation
- `lib/prompt-config.js`: parameterized Buy/Sell prompt configs
- `lib/llm.js`: OpenAI `gpt-5.4` request logic and prompt assembly
- `assets/icon-128.png`: extension icon
- `AGENTS.md`: project guidance for coding agents

## How It Works

1. Open the popup and click `Start`.
2. The extension captures the current visible tab.
3. It checks the tab title and URL for stock-chart keywords.
4. If validation passes, the side panel lets the user choose `Buy` or `Sell`.
5. The user fills in:
   - `Current Shares`
   - `Average Cost`
   - `Intent`
6. The extension sends:
   - the screenshot
   - page title / URL
   - Buy/Sell prompt
   - user position context
   to OpenAI `gpt-5.4`
7. The response must be valid JSON and is shown in the side panel.
8. The extension repeats every 5 minutes until the user stops it or it reaches 70 rounds.

## OpenAI Setup

The extension currently uses the OpenAI Responses API with:

- model: `gpt-5.4`
- image input: `high` detail
- JSON output mode

Before using Buy/Sell analysis:

1. Open the side panel.
2. Enter your OpenAI API key in the `OpenAI Setup` section.
3. Click `Save Key`.

Without an API key, the extension will not allow you to continue into the Buy/Sell analysis flow.

## Load Locally In Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the cloned project folder on your machine, for example:

```text
stock-chart-analyzer-mvp/
```

5. Open a stock chart page
6. Click the extension icon
7. Click `Start`
8. Use the side panel to save your API key, choose `Buy` or `Sell`, and start monitoring

## Prompt Design

The prompts are parameterized in `lib/prompt-config.js`.

Current prompt behavior:

- `Buy` only produces stock buy guidance
- `Sell` only produces stock sell / trim / exit guidance
- responses are expected to be:
  - concise
  - direct
  - JSON-only
  - focused on `LIMIT` orders

Expected response fields include:

- `mode`
- `signal`
- `orderType`
- `limitPrice`
- `confidence`
- `summary`
- `levels`
- `riskNote`
- `symbol`
- `timeframe`

## Notes

- This extension is for prototype/demo use only.
- It is not financial advice.
- All model outputs can be wrong, incomplete, stale, or misleading.
- Do not use this extension as the sole basis for buying or selling securities.
- Use at your own risk.
- Storing an API key in extension local storage is convenient for MVP testing, but not the final security model you would want in production.

## Disclaimer

- This project is an experimental stock-chart analysis prototype.
- It does not provide financial, investment, legal, or tax advice.
- Nothing in this repository should be treated as a recommendation to buy, sell, or hold any security.
- The generated output is only an automated model opinion based on limited context and may be incorrect.
- You are fully responsible for any decisions, losses, or consequences arising from use of this project.

## Security

- The current MVP stores the OpenAI API key in `chrome.storage.local` inside the extension.
- That is acceptable for local testing, but it is not a production-grade secret-management design.
- Do not commit API keys, tokens, or personal credentials into this repository.
- If you fork or modify this project, review all storage, logging, and network behavior before using real credentials.
- A stronger production design would move model access behind a backend you control, so the client extension never holds the raw API key.

## Next Improvements

- validate charts from the screenshot itself, not only page keywords
- add stronger OpenAI error handling and retry behavior
- highlight `limitPrice` more clearly in the UI
- add screenshot cropping so only the chart region is sent
- add tests for state transitions and message handling
- move API access behind a safer backend if this evolves beyond MVP
