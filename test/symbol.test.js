import { test } from "node:test";
import assert from "node:assert/strict";
import { guessSymbol, sanitizeUrl } from "../lib/symbol.js";

test("guessSymbol: $TICKER in title", () => {
  assert.equal(guessSymbol("Buy $TSLA now", ""), "TSLA");
});

test("guessSymbol: parenthesized ticker in title", () => {
  assert.equal(guessSymbol("Tesla Inc (TSLA) - Quote", ""), "TSLA");
});

test("guessSymbol: symbol= URL pattern", () => {
  assert.equal(guessSymbol("", "https://finance.yahoo.com/quote/AAPL"), "AAPL");
});

test("guessSymbol: ticker/ URL pattern", () => {
  assert.equal(guessSymbol("", "https://example.com/ticker/NVDA"), "NVDA");
});

test("guessSymbol: title lead with dash", () => {
  assert.equal(guessSymbol("MSFT - Microsoft Corp", ""), "MSFT");
});

test("guessSymbol: title lead with pipe", () => {
  assert.equal(guessSymbol("AMD | Advanced Micro Devices", ""), "AMD");
});

test("guessSymbol: returns null when no match", () => {
  assert.equal(guessSymbol("some random page", "https://example.com/page"), null);
});

test("sanitizeUrl: strips query and fragment", () => {
  assert.equal(
    sanitizeUrl("https://example.com/path?key=secret#frag"),
    "https://example.com/path"
  );
});

test("sanitizeUrl: empty input", () => {
  assert.equal(sanitizeUrl(""), "");
});

test("sanitizeUrl: invalid URL", () => {
  assert.equal(sanitizeUrl("not a url"), "");
});
