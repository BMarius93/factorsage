/**
 * Issuer-name comparison for index reconstruction and resolution.
 *
 * Names are evidence, never identity: a name decides between candidates only when tickers could
 * not, and a resolution uses a name mismatch only to refuse a link, never to make one. The
 * comparison is deliberately simple and deterministic — normalized word tokens and character
 * bigrams — so the same inputs always give the same score on every machine.
 */

/** Words that say what kind of entity an issuer is rather than which one it is. */
const STOP_WORDS = new Set([
  "a",
  "ag",
  "and",
  "b",
  "c",
  "cl",
  "class",
  "co",
  "com",
  "common",
  "companies",
  "company",
  "corp",
  "corporation",
  "de",
  "delisted",
  "group",
  "hldgs",
  "holding",
  "holdings",
  "inc",
  "incorporated",
  "int",
  "intl",
  "l",
  "llc",
  "lp",
  "ltd",
  "limited",
  "n",
  "new",
  "nv",
  "of",
  "old",
  "ordinary",
  "plc",
  "sa",
  "se",
  "shares",
  "stock",
  "the",
  "trust",
  "v",
]);

/** The identifying words of an issuer name, lower-cased, without punctuation or entity words. */
export function issuerNameTokens(name: string | null | undefined): string[] {
  if (!name) {
    return [];
  }
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function bigrams(value: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let index = 0; index < value.length - 1; index += 1) {
    const gram = value.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function dice<T>(left: Map<T, number>, right: Map<T, number>): number {
  let leftSize = 0;
  let rightSize = 0;
  let shared = 0;
  for (const count of left.values()) {
    leftSize += count;
  }
  for (const count of right.values()) {
    rightSize += count;
  }
  if (leftSize + rightSize === 0) {
    return 0;
  }
  for (const [key, count] of left) {
    shared += Math.min(count, right.get(key) ?? 0);
  }
  return (2 * shared) / (leftSize + rightSize);
}

function counts<T>(values: readonly T[]): Map<T, number> {
  const result = new Map<T, number>();
  for (const value of values) {
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return result;
}

/**
 * How alike two issuer names are, from 0 (nothing shared) to 1 (the same identifying words).
 *
 * The better of a word-level and a character-level Dice coefficient over the identifying words, so
 * "Wachovia Corp." and "Wachovia Corporation" score 1 and "Allergan plc" and "Allergan, Inc." score
 * 1, while "Mr. Cooper Group" and "Washington Mutual" score near 0. Either name missing scores 0.
 */
export function issuerNameSimilarity(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const leftTokens = issuerNameTokens(left);
  const rightTokens = issuerNameTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }
  const words = dice(counts(leftTokens), counts(rightTokens));
  const characters = dice(
    bigrams(leftTokens.join(" ")),
    bigrams(rightTokens.join(" ")),
  );
  return Math.max(words, characters);
}
