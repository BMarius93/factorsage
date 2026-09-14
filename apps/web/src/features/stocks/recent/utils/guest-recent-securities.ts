import { RECENT_SECURITY_LIMIT } from "@intrinsic/contracts";

/** One key, versioned, so a future shape change cannot be mistaken for this one. */
export const GUEST_RECENT_SECURITIES_KEY = "factorsage.recent-securities.v1";

/**
 * A signed-out visitor's recently viewed securities, kept in this browser.
 *
 * Only canonical `Security` ids are stored — never a symbol, a company name or a typed search
 * string. Two reasons, and both matter: the id is the catalog's identity, so the labels can be
 * resolved fresh on every read instead of being rendered from whatever a previous visit happened to
 * cache, and an id is the minimum this feature needs, so nothing about a visitor's browsing accrues
 * in their browser beyond it.
 *
 * Every access is wrapped: `localStorage` throws outright in a browser configured to block site
 * data, and recents are convenience UI that must never be the reason a page fails.
 */
export function readGuestRecentSecurityIds(): string[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(GUEST_RECENT_SECURITIES_KEY);
  } catch {
    return [];
  }
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeRecentSecurityIds(
      parsed.filter((value): value is string => typeof value === "string"),
    );
  } catch {
    // Corrupt or hand-edited storage is the same as no storage.
    return [];
  }
}

/**
 * Moves one security to the front of this browser's recents and returns the new set.
 *
 * Deduplicating by moving rather than by skipping is the whole ordering rule: re-viewing a stock
 * already in the list promotes it instead of adding a second entry.
 */
export function rememberGuestRecentSecurityId(securityId: string): string[] {
  const next = normalizeRecentSecurityIds([
    securityId,
    ...readGuestRecentSecurityIds(),
  ]);
  try {
    window.localStorage.setItem(
      GUEST_RECENT_SECURITIES_KEY,
      JSON.stringify(next),
    );
  } catch {
    // A full or blocked store costs the visitor their recents and nothing else.
  }
  return next;
}

/** Newest first, no duplicates, at most `RECENT_SECURITY_LIMIT` — the one ordering rule. */
function normalizeRecentSecurityIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed === "" || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
    if (ordered.length === RECENT_SECURITY_LIMIT) {
      break;
    }
  }
  return ordered;
}
