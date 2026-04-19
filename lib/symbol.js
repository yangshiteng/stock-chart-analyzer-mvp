export function sanitizeUrl(pageUrl) {
  if (!pageUrl) return "";
  try {
    const u = new URL(pageUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

export function guessSymbol(pageTitle, pageUrl) {
  const haystack = `${pageTitle || ""} ${pageUrl || ""}`;

  // Prefer $TSLA or explicit (TSLA) patterns first.
  const explicit = haystack.match(/\$([A-Z]{1,5})\b/) || haystack.match(/\(([A-Z]{1,5})\)/);
  if (explicit) return explicit[1];

  // URL patterns like /symbol/TSLA, /quote/TSLA, /stock/TSLA, ?symbol=TSLA
  const urlPattern = haystack.match(/(?:symbol|quote|stock|ticker)[\/=:]([A-Z]{1,5})\b/i);
  if (urlPattern) return urlPattern[1].toUpperCase();

  // Title like "TSLA - Tesla ..." or "TSLA: ..."
  const titleLead = (pageTitle || "").match(/^\s*([A-Z]{1,5})\s*[-:·|]/);
  if (titleLead) return titleLead[1];

  return null;
}
