// Regular-session US equity hours: 9:30–16:00 America/New_York, Mon–Fri.
const US_MARKET_OPEN_MINUTE = 9 * 60 + 30;
const US_MARKET_CLOSE_MINUTE = 16 * 60;

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
  return minutesOfDay >= US_MARKET_OPEN_MINUTE && minutesOfDay < US_MARKET_CLOSE_MINUTE;
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

export function getUsMarketSessionPhase(now = new Date()) {
  const minutesOfDay = getUsMarketMinutesOfDay(now);

  if (minutesOfDay === null) {
    return "closed";
  }

  if (minutesOfDay < US_MARKET_OPEN_MINUTE) {
    return "before_open";
  }

  if (minutesOfDay < US_MARKET_CLOSE_MINUTE) {
    return "open";
  }

  return "after_close";
}

// Returns the US-Eastern calendar date at `now` as "YYYY-MM-DD".
// Used as the "trading day" key: two timestamps with the same return value are the same trading day.
// Weekends return the weekend's own date (caller is responsible for treating weekend positions as stale).
export function getUsTradingDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

// True if we are within the last `leadMinutes` before 16:00 ET (default 10min → 15:50+).
export function isNearUsMarketClose(now = new Date(), leadMinutes = 10) {
  const mod = getUsMarketMinutesOfDay(now);
  if (mod === null) return false;
  const closeMod = US_MARKET_CLOSE_MINUTE;
  return mod >= closeMod - leadMinutes && mod < closeMod;
}
