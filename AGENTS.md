# Project: Stock Chart Analyzer Chrome Extension

## Goal
Build a Chrome Extension (Manifest V3) MVP.

The extension should:
- capture the current tab screenshot
- check if it is a stock chart by keywords
- if not, show a notification and stop
- if yes, let the user choose Buy or Sell mode
- send the screenshot to the LLM with the corresponding prompt
- display the result in a side panel
- repeat every 5 minutes
- stop after 70 rounds or when user stops

## Requirements
- keep implementation simple
- prioritize working prototype over perfect architecture
- use modular files where reasonable
- all LLM outputs must be JSON
- avoid overengineering

## MVP Scope
- popup with Start and Stop buttons
- side panel UI for results
- screenshot current tab
- validation prompt
- buy/sell prompt
- notifications
- chrome.alarms for scheduling