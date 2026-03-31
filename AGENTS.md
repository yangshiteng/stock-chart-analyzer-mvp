# Project: Stock Chart Analyzer Chrome Extension

## Current Goal

Maintain and iterate on a working Chrome Extension (Manifest V3) MVP for stock-chart validation, recurring monitoring, and limit-order recommendation workflows.

## Current Product Behavior

The extension currently does the following:

- validates the active tab as a stock-chart page using keyword rules from page title and URL
- opens a side panel workflow only after the user explicitly starts validation from the popup
- stores the OpenAI API key locally inside the extension for MVP use
- lets the user choose `Buy` or `Sell`
- asks the user for trade context:
  - current shares
  - average cost
  - intent
- sends the visible chart screenshot plus structured context to OpenAI `gpt-5.4`
- requires all analysis responses to be valid JSON
- renders the latest recommendation as a user-friendly card in the side panel
- monitors every 5 minutes with `chrome.alarms`
- binds monitoring to the original chart tab instead of silently switching to the current active page
- pauses automatically if the user leaves the original chart tab
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
- screenshot capture depends on the visible active tab
- the monitoring session is bound to the original validated chart tab
- leaving the bound tab should pause monitoring, not capture some unrelated active page
- `Stop` means pause, not full exit
- `Exit` means fully clear the current monitoring session
- English is the internal analysis language
- Chinese output is produced as a second translation step after the English analysis
- schema keys and enum values remain English even when the UI is Chinese

## Current UX Scope

- popup with:
  - language selector
  - OpenAI API key management
  - single primary `Start` action
- side panel with:
  - status summary
  - Buy/Sell selection
  - position-context form
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
- English prompt configs in `lib/prompt-config.js`
- translation-aware output handling in `lib/llm.js`
- UI translations in `lib/i18n.js`

## Near-Term Improvement Areas

- clean up remaining encoding / mojibake issues in older string tables
- add tests for state transitions and message handling
- improve chart validation beyond title / URL keyword rules
- consider chart-region cropping before upload
- make notification / re-entry behavior more polished without fighting Chrome side panel gesture limits
- improve API-key handling if the project evolves beyond MVP
