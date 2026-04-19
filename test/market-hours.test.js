import { test } from "node:test";
import assert from "node:assert/strict";
import { getUsMarketMinutesOfDay, isNearUsMarketClose, isWithinUsMarketHours } from "../lib/market-hours.js";

// Pick dates during Eastern Standard Time (not DST) for deterministic offsets.
// 2026-01-05 is a Monday. EST = UTC-5.
// 9:29 ET = 14:29 UTC, 9:30 ET = 14:30 UTC, 15:59 ET = 20:59 UTC, 16:00 ET = 21:00 UTC.

test("market-hours: Monday 9:29 ET is closed", () => {
  assert.equal(isWithinUsMarketHours(new Date("2026-01-05T14:29:00Z")), false);
});

test("market-hours: Monday 9:30 ET is open", () => {
  assert.equal(isWithinUsMarketHours(new Date("2026-01-05T14:30:00Z")), true);
});

test("market-hours: Monday 15:59 ET is open", () => {
  assert.equal(isWithinUsMarketHours(new Date("2026-01-05T20:59:00Z")), true);
});

test("market-hours: Monday 16:00 ET is closed", () => {
  assert.equal(isWithinUsMarketHours(new Date("2026-01-05T21:00:00Z")), false);
});

test("market-hours: Saturday always closed", () => {
  // 2026-01-10 is Saturday; midday ET.
  assert.equal(isWithinUsMarketHours(new Date("2026-01-10T17:00:00Z")), false);
});

test("market-hours: Sunday always closed", () => {
  assert.equal(isWithinUsMarketHours(new Date("2026-01-11T17:00:00Z")), false);
});

test("market-hours: DST day (June Monday) 9:30 ET is open", () => {
  // 2026-06-01 is Monday; EDT = UTC-4, so 9:30 ET = 13:30 UTC.
  assert.equal(isWithinUsMarketHours(new Date("2026-06-01T13:30:00Z")), true);
});

test("market-hours: DST day (June Monday) 16:00 ET is closed", () => {
  assert.equal(isWithinUsMarketHours(new Date("2026-06-01T20:00:00Z")), false);
});

test("getUsMarketMinutesOfDay: weekday returns minute-of-day", () => {
  // 14:30 UTC on 2026-01-05 (Mon, EST) = 09:30 ET = 570
  assert.equal(getUsMarketMinutesOfDay(new Date("2026-01-05T14:30:00Z")), 570);
});

test("getUsMarketMinutesOfDay: weekend returns null", () => {
  assert.equal(getUsMarketMinutesOfDay(new Date("2026-01-10T17:00:00Z")), null);
});

test("isNearUsMarketClose: 15:49 ET is not near close", () => {
  // 15:49 ET EST = 20:49 UTC
  assert.equal(isNearUsMarketClose(new Date("2026-01-05T20:49:00Z")), false);
});

test("isNearUsMarketClose: 15:50 ET is near close (10-minute default)", () => {
  assert.equal(isNearUsMarketClose(new Date("2026-01-05T20:50:00Z")), true);
});

test("isNearUsMarketClose: 15:59 ET is near close", () => {
  assert.equal(isNearUsMarketClose(new Date("2026-01-05T20:59:00Z")), true);
});

test("isNearUsMarketClose: 16:00 ET is not (market already closed)", () => {
  assert.equal(isNearUsMarketClose(new Date("2026-01-05T21:00:00Z")), false);
});
