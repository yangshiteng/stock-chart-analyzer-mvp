# Project: Stock Chart Analyzer Chrome Extension

## Current Goal
Maintain and iterate on a working Chrome Extension (Manifest V3) MVP for stock-chart monitoring and limit-order suggestions.

## Current Product Behavior
The extension currently does the following:

- captures the current visible tab screenshot
- validates whether the page looks like a stock chart using keyword rules from page title and URL
- stops and shows a notification if validation fails
- opens a side panel workflow if validation passes
- requires the user to save an OpenAI API key locally in the extension
- lets the user choose `Buy` or `Sell`
- asks the user for session context:
  - current shares
  - average cost
  - intent
- sends the screenshot plus structured prompt context to OpenAI `gpt-5.4`
- expects all analysis responses to be valid JSON
- displays the latest JSON result in the side panel
- repeats every 5 minutes with `chrome.alarms`
- stops after 70 rounds or when the user clicks `Stop`

## Product Constraints
- keep implementation simple
- prioritize working prototype over perfect architecture
- use modular files where reasonable
- all LLM outputs must be JSON
- avoid overengineering

## Important Behavior Rules
- stock chart validation is keyword-based right now, not image-based
- Buy/Sell prompts are parameterized and live in `lib/prompt-config.js`
- this project is about ordinary stock buy/sell decisions, not long/short trading
- prompts should favor direct limit-order suggestions:
  - buy mode should suggest a `LIMIT BUY` price when appropriate
  - sell mode should suggest a `LIMIT SELL` price when appropriate
- responses should be concise, direct, and not vague

## Current UX Scope
- popup with `Start` and `Stop`
- side panel with:
  - OpenAI API key setup
  - Buy/Sell selection
  - position-context form
  - validation JSON
  - latest analysis JSON
  - recent round history
- screenshot current tab
- notifications
- recurring monitoring with `chrome.alarms`

## Current Technical Scope
- Manifest V3
- background service worker
- `chrome.storage.local` for monitor state and app settings
- OpenAI Responses API using `gpt-5.4`
- image input with the captured tab screenshot

## Near-Term Improvement Areas
- better OpenAI error messaging
- chart-region cropping before upload
- stronger validation of model output fields
- tests for state transitions and workflow logic
- safer API-key handling for non-MVP usage
