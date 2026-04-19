import { test } from "node:test";
import assert from "node:assert/strict";
import { getUsMarketMinutesOfDay, getUsTradingDay, isNearUsMarketClose, isWithinUsMarketHours } from "../lib/market-hours.js";

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

test("getUsTradingDay: same ET day → same key", () => {
  // 2026-01-05 10:00 ET (15:00 UTC EST) and 15:00 ET (20:00 UTC EST) are same day
  const a = getUsTradingDay(new Date("2026-01-05T15:00:00Z"));
  const b = getUsTradingDay(new Date("2026-01-05T20:00:00Z"));
  assert.equal(a, "2026-01-05");
  assert.equal(b, "2026-01-05");
});

test("getUsTradingDay: next ET day → new key", () => {
  // Same UTC day (2026-01-05 23:00 UTC = 18:00 ET), but 2026-01-06 03:00 UTC = 22:00 ET prev day
  // Use a clear cross-midnight ET pair: 2026-01-05 22:00 UTC = 17:00 ET (Mon),
  // 2026-01-06 10:00 UTC = 05:00 ET (Tue).
  const mon = getUsTradingDay(new Date("2026-01-05T22:00:00Z"));
  const tue = getUsTradingDay(new Date("2026-01-06T10:00:00Z"));
  assert.equal(mon, "2026-01-05");
  assert.equal(tue, "2026-01-06");
  assert.notEqual(mon, tue);
});

test("getUsTradingDay: UTC-day boundary but same ET day (late evening ET)", () => {
  // 2026-01-05 23:00 ET = 2026-01-06 04:00 UTC → ET day still 2026-01-05
  assert.equal(getUsTradingDay(new Date("2026-01-06T04:00:00Z")), "2026-01-05");
});
