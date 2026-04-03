# Project: Stock Chart Analyzer Chrome Extension

## Current Goal

Maintain and iterate on a working Chrome Extension (Manifest V3) MVP for stock-chart validation, recurring monitoring, execution-assistant recommendations, optional Discord delivery, and lightweight result cues.

## Current Product Behavior

The extension currently does the following:

- validates the active tab as a stock-chart page using keyword rules from the page title and URL
- opens the side panel workflow only after the user explicitly starts validation from the popup
- stores the OpenAI API key locally inside the extension for MVP use
- stores an optional Discord webhook URL locally inside the extension for alert delivery
- asks the user for execution constraints instead of asking the user to choose a trading intent
- collects:
  - current shares
  - average cost
  - available cash
  - whether averaging down is allowed
  - whether sell-side actions are allowed
  - buy risk style
  - sell risk style
  - auto-stop duration
- sends the visible chart screenshot plus structured execution constraints to OpenAI `gpt-5.4`
- requires every analysis response to be valid JSON
- requires the model to return a dedicated `whatToDoNow` instruction for the primary guidance block
- requires the model to return visible support and resistance references
- requires the model to return one limit-buy reference and one limit-sell reference
- renders the latest recommendation as a user-friendly card in the side panel
- shows a loading state during each new monitoring round while the next screenshot analysis is in flight
- monitors every 5 minutes with `chrome.alarms`
- defaults auto-stop to 30 minutes and supports 1h / 2h / 4h / 8h options
- binds monitoring to the original chart tab instead of silently switching to the current active page
- pauses automatically if the user leaves the original chart tab inside the monitored window
- can send Discord notifications for successful recommendation rounds when a webhook is configured
- keeps Discord payloads aligned with the compact side-panel recommendation model instead of exposing deprecated order-management fields
- plays a short audio cue when a fresh recommendation round finishes successfully
- lets the user:
  - pause with `Stop`
  - resume with `Continue`
  - restart with `Restart`
  - fully terminate the session with `Exit`

## Product Constraints

- keep implementation simple
- prefer a working prototype over perfect architecture
- keep all model outputs JSON-structured
- avoid overengineering
- preserve a clear separation between:
  - internal analysis structure
  - UI presentation

## Important Behavior Rules

- stock-chart validation is keyword-based right now, not image-based
- screenshot capture depends on the visible active tab in the bound monitoring window
- the monitoring session is bound to the original validated chart tab
- leaving the bound tab should pause monitoring, not capture some unrelated active page
- `Stop` means pause, not full exit
- `Exit` means fully clear the current monitoring session
- auto-stop should never default to "run forever"; default to 30 minutes if the rule is missing or invalid
- English is the internal analysis language
- Chinese output is produced as a second translation step after the English analysis
- schema keys and enum values remain English even when the UI is Chinese
- buy-reference prices must be below current price when current price is readable
- sell-reference prices must be above current price when current price is readable
- Discord webhook alerts are optional and should never be treated as a guaranteed delivery channel
- Discord webhook URLs are secrets and must never be committed

## Current UX Scope

- popup with:
  - language selector
  - OpenAI API key management
  - Discord webhook management
  - single primary `Start` action
- side panel with:
  - status summary
  - execution-constraints form
  - auto-stop selector
  - recommendation card
  - `Stop`, `Continue`, `Restart`, `Exit`
- side panel availability tied to validated / active session tabs

## Current Technical Scope

- Manifest V3
- background service worker
- `chrome.storage.local` for monitor state and app settings
- `chrome.alarms` for recurring monitoring
- OpenAI Responses API using `gpt-5.4`
- visible-tab screenshot capture
- offscreen audio playback for result cues
- English prompt config in `lib/prompt-config.js`
- translation-aware output handling in `lib/llm.js`
- UI translations in `lib/i18n.js`

## Current Recommendation Schema

The model currently returns a strict JSON object with:

- `action`
  - `OPEN`
  - `ADD`
  - `HOLD`
  - `REDUCE`
  - `EXIT`
  - `WAIT`
- `orderType`
  - `LIMIT`
  - `NONE`
- `limitPrice`
- `sizeSuggestion`
- `confidence`
- `whatToDoNow`
- `summary`
- `levels.entry`
- `levels.target`
- `levels.invalidation`
- `riskNote`
- `supportLevels`
- `resistanceLevels`
- `symbol`
- `currentPrice`
- `buyOrderGuidance.price`
- `buyOrderGuidance.shares`
- `buyOrderGuidance.reason`
- `sellOrderGuidance.price`
- `sellOrderGuidance.shares`
- `sellOrderGuidance.reason`
- `timeframe`

## Near-Term Improvement Areas

- clean up remaining encoding / mojibake issues in older string tables
- add tests for state transitions and message handling
- improve chart validation beyond title / URL keyword rules
- consider chart-region cropping before upload
- add finer control for Discord alerts, such as signal-change-only delivery
- improve API-key handling if the project evolves beyond MVP
