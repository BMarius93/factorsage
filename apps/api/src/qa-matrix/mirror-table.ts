/**
 * The copy primitives QA-matrix provisioning is built on.
 *
 * Provisioning used to insert every row with `skipDuplicates`, which makes the copy a *union* of
 * whatever the matrix database already held and whatever the source holds now: a row the source has
 * since corrected keeps its old value, and a row the source no longer has keeps existing. The
 * data-correctness audit found exactly that (AUD-06) — ADBE 2026-09-09 was an in-session bar in the
 * matrix copy and the final bar in development.
 *
 * So the copy is expressed as one of two explicit semantics instead:
 *
 * - {@link mirrorTableScope} for the market data itself. A scope (one table, optionally restricted
 *   to one security or series) is *replaced*: the target's rows in that scope are deleted and the
 *   source's rows are inserted. The result does not depend on what the target held before.
 * - {@link reconcileIdentityRows} for the three identity tables (`Security`, `Benchmark`,
 *   `BenchmarkSeries`). Their rows are referenced by the QA account's lists, strategies and runs, so
 *   they are never deleted; rows missing from the target are inserted, and rows whose content
 *   differs are updated to the source's content.
 *
 * Both are generic over a port so the algorithms are testable without two databases; the Prisma
 * bindings live in `provision-matrix-database.ts`.
 */

/** Rows per source read page and per insert batch. Sized for wide `DailyDerivedState` rows. */
export const MIRROR_PAGE = 2_000;

export type MirrorPort<T> = {
  /** A page of the source's rows for this scope, in a stable order. */
  readSourcePage(skip: number, take: number): Promise<readonly T[]>;
  /** Deletes the target's rows for this scope. Returns how many were deleted. */
  deleteTargetScope(): Promise<number>;
  /** Inserts rows into the target. Returns how many were inserted. */
  insertTarget(rows: readonly T[]): Promise<number>;
};

export type MirrorResult = {
  /** Rows inserted into the target — the scope's row count after the copy. */
  readonly inserted: number;
  /** Rows deleted from the target before inserting, stale or not. */
  readonly deleted: number;
};

/**
 * Replaces the target's rows for one scope with the source's rows for that same scope.
 *
 * The delete comes first and is not wrapped in a transaction with the inserts. A crash in between
 * therefore leaves the scope short rather than stale, which is the safer of the two: provisioning
 * is re-runnable and idempotent, and the matrix preflight verifies price, derived-state and
 * fundamentals coverage per security before a single run executes, so a half-copied scope stops the
 * matrix instead of silently shortening it.
 */
export async function mirrorTableScope<T>(
  port: MirrorPort<T>,
  page: number = MIRROR_PAGE,
): Promise<MirrorResult> {
  const deleted = await port.deleteTargetScope();
  let inserted = 0;
  for (let skip = 0; ;) {
    const rows = await port.readSourcePage(skip, page);
    if (rows.length === 0) {
      return { inserted, deleted };
    }
    inserted += await port.insertTarget(rows);
    skip += rows.length;
    if (rows.length < page) {
      return { inserted, deleted };
    }
  }
}

export type IdentityPort<T extends { readonly id: string }> = {
  readSource(): Promise<readonly T[]>;
  readTarget(): Promise<readonly T[]>;
  insertTarget(rows: readonly T[]): Promise<number>;
  updateTarget(row: T): Promise<void>;
};

export type ReconcileResult = {
  readonly inserted: number;
  readonly updated: number;
  /** Rows the target has and the source does not. They are left alone; see the module comment. */
  readonly extra: number;
};

/**
 * Brings the target's identity rows in line with the source without deleting anything.
 *
 * `ignoredFields` names the columns Prisma rewrites on its own during an update — `updatedAt` is
 * the only one here. Comparing them would make every row differ forever, and they describe when the
 * copy wrote the row rather than what the data says.
 */
export async function reconcileIdentityRows<T extends { readonly id: string }>(
  port: IdentityPort<T>,
  ignoredFields: readonly string[] = ["updatedAt"],
): Promise<ReconcileResult> {
  const [sourceRows, targetRows] = await Promise.all([
    port.readSource(),
    port.readTarget(),
  ]);
  const target = new Map(targetRows.map((row) => [row.id, row]));
  const missing: T[] = [];
  const differing: T[] = [];
  for (const row of sourceRows) {
    const existing = target.get(row.id);
    if (!existing) {
      missing.push(row);
    } else if (
      fingerprint(row, ignoredFields) !== fingerprint(existing, ignoredFields)
    ) {
      differing.push(row);
    }
  }
  const inserted = missing.length > 0 ? await port.insertTarget(missing) : 0;
  for (const row of differing) {
    await port.updateTarget(row);
  }
  const source = new Set(sourceRows.map((row) => row.id));
  return {
    inserted,
    updated: differing.length,
    extra: targetRows.filter((row) => !source.has(row.id)).length,
  };
}

function fingerprint(row: object, ignoredFields: readonly string[]): string {
  const ignored = new Set(ignoredFields);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => !ignored.has(key))
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, value]) => [key, canonical(value)]),
    ),
  );
}

/**
 * A comparable form of a stored value.
 *
 * Rows carry `Date`, `BigInt`, `Decimal` and `JSONB` values. `Decimal` is recognized structurally —
 * by having a `toString` of its own — rather than by importing Prisma's runtime, which keeps this
 * module free of the client it compares rows from.
 */
function canonical(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object") {
    if (value.toString !== Object.prototype.toString) {
      return String(value);
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}
