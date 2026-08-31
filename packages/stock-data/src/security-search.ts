import type { Security } from "@intrinsic/domain";

/**
 * Dropdown-sized default for the global stock search. The search surface is a small overlay list,
 * not a results page, so the ceiling stays low enough to remain scannable without scrolling.
 */
export const DEFAULT_SECURITY_SEARCH_LIMIT = 8;

/** Hard ceiling so a caller-supplied limit cannot turn the search into a bulk export. */
export const MAX_SECURITY_SEARCH_LIMIT = 10;

/**
 * Candidates read per returned row.
 *
 * The store cannot rank, so it must return more rows than the caller keeps; otherwise a strong
 * symbol-prefix match could be truncated away by an alphabetical page of weak name matches.
 */
export const SECURITY_SEARCH_CANDIDATE_FACTOR = 5;

/**
 * Relevance tiers, strongest first. A user typing into a ticker search is almost always reaching
 * for a symbol, so every symbol match outranks every name-only match.
 */
const EXACT_SYMBOL = 0;
const SYMBOL_PREFIX = 1;
const NAME_PREFIX = 2;
const NAME_WORD_PREFIX = 3;
const NAME_SUBSTRING = 4;
const NO_MATCH = 5;

/** Collapses internal whitespace so `"  apple  inc "` and `"apple inc"` search identically. */
export function normalizeSearchTerm(term: string): string {
  return term.trim().replace(/\s+/g, " ");
}

/** Clamps a caller-supplied limit into the supported dropdown range. */
export function resolveSecuritySearchLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_SECURITY_SEARCH_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SECURITY_SEARCH_LIMIT);
}

function relevance(term: string, security: Security): number {
  const symbol = security.symbol.toLowerCase();
  const name = security.name.toLowerCase();

  if (symbol === term) {
    return EXACT_SYMBOL;
  }
  if (symbol.startsWith(term)) {
    return SYMBOL_PREFIX;
  }
  if (name.startsWith(term)) {
    return NAME_PREFIX;
  }
  // A match at a word boundary ("micro" in "Advanced Micro Devices") reads as intentional, while a
  // match inside a word ("ple" in "Apple") is usually incidental.
  if (name.includes(` ${term}`)) {
    return NAME_WORD_PREFIX;
  }
  if (name.includes(term)) {
    return NAME_SUBSTRING;
  }
  return NO_MATCH;
}

/**
 * Orders store candidates by relevance and truncates to `limit`.
 *
 * Pure and persistence-free so ranking stays testable without a database, and so a future store
 * implementation cannot quietly change which result a user lands on.
 */
export function rankSecurityMatches(
  term: string,
  candidates: readonly Security[],
  limit: number,
): Security[] {
  const normalized = normalizeSearchTerm(term).toLowerCase();
  if (normalized === "") {
    return [];
  }

  return candidates
    .map((security) => ({ security, score: relevance(normalized, security) }))
    .filter((entry) => entry.score !== NO_MATCH)
    .sort((a, b) => {
      if (a.score !== b.score) {
        return a.score - b.score;
      }
      // Delisted or inactive names stay reachable but never outrank a tradable one.
      if (a.security.isActivelyTrading !== b.security.isActivelyTrading) {
        return a.security.isActivelyTrading ? -1 : 1;
      }
      // Shorter symbols are the more prominent listing far more often than not.
      if (a.security.symbol.length !== b.security.symbol.length) {
        return a.security.symbol.length - b.security.symbol.length;
      }
      return a.security.symbol.localeCompare(b.security.symbol);
    })
    .slice(0, limit)
    .map((entry) => entry.security);
}
