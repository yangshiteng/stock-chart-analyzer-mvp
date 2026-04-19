// Regular-session US equity hours: 9:30–16:00 America/New_York, Mon–Fri.
// Uses Intl.DateTimeFormat so DST is handled automatically.
export function isWithinUsMarketHours(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);

  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const weekday = lookup.weekday;
  const hour = Number(lookup.hour);
  const minute = Number(lookup.minute);

  if (weekday === "Sat" || weekday === "Sun") {
    return false;
  }

  const minutesOfDay = hour * 60 + minute;
  return minutesOfDay >= 570 && minutesOfDay < 960;
}

// Returns the current US-market minute-of-day (Eastern), or null outside the regular session.
export function getUsMarketMinutesOfDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);

  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  if (lookup.weekday === "Sat" || lookup.weekday === "Sun") {
    return null;
  }
  return Number(lookup.hour) * 60 + Number(lookup.minute);
}

// True if we are within the last `leadMinutes` before 16:00 ET (default 10min → 15:50+).
export function isNearUsMarketClose(now = new Date(), leadMinutes = 10) {
  const mod = getUsMarketMinutesOfDay(now);
  if (mod === null) return false;
  const closeMod = 16 * 60;
  return mod >= closeMod - leadMinutes && mod < closeMod;
}
