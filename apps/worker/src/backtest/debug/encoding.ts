/**
 * How a forensic archive writes numbers, dates and file names.
 *
 * The whole point of the archive is that another engineer — or another program — can read it
 * without knowing anything about this codebase, so every ambiguity has to be resolved here rather
 * than left to whoever opens the JSON.
 */

/**
 * The archive's number encoding: **`NaN` and the infinities become `null`; a real `0` stays `0`.**
 *
 * Inside the engine `NaN` is the single representation of an absent / NOT_EVALUABLE value, and a
 * numeric zero is a genuine reading — `RSI = 0` and `Margin of Safety = 0` are real answers, not
 * missing data. JSON has no `NaN`, and the two ways of avoiding that question are both wrong:
 * `JSON.stringify` turns `NaN` into `null` **silently**, which is right by accident and unstated,
 * while any numeric sentinel (`0`, `-1`) would be indistinguishable from a reading.
 *
 * So it is stated, applied deliberately at every numeric field the archive writes, and covered by
 * regression tests. `null` means "the engine had no value here"; a number means the engine read
 * exactly that number.
 */
export function archiveNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

/** The same encoding over a column. */
export function archiveNumbers(values: ArrayLike<number>): (number | null)[] {
  const encoded: (number | null)[] = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    encoded[index] = archiveNumber(values[index]);
  }
  return encoded;
}

/**
 * A file-name-safe form of a symbol, so a frame file is readable at a glance.
 *
 * Symbols reach here from a user's own stock list and can carry characters a path cannot
 * (`BRK.B` is fine, a hypothetical `A/B` is not), and case-insensitive filesystems make two symbols
 * that differ only in case collide. The security id is appended by the caller, so this only has to
 * be safe — the id is what makes the name unique.
 */
export function safeFileSymbol(symbol: string): string {
  const cleaned = symbol.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 24);
  return cleaned.length > 0 ? cleaned : "SECURITY";
}

/** A file-name-safe form of an identifier that is expected to be safe already. */
export function safeFileId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/**
 * Pretty JSON with a trailing newline.
 *
 * Readability is worth the bytes here: the archive is opened by a human or pasted into a chat far
 * more often than it is parsed at scale, and the large payloads — frames, equity, trades — are
 * NDJSON or column arrays rather than deeply nested objects anyway.
 */
export function archiveJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** One NDJSON line. */
export function archiveNdjsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
