import { describe, expect, it } from "vitest";
import {
  mirrorTableScope,
  reconcileIdentityRows,
  type IdentityPort,
  type MirrorPort,
} from "./mirror-table";
import { discardMatrixProjections } from "./provision-matrix-database";

type Bar = { readonly date: string; readonly close: number; volume?: bigint };

/**
 * Two in-memory tables behind the mirror port, keyed the way `DailyPrice` is.
 *
 * The target is seeded with whatever a previous provisioning left behind, which is the whole point
 * of AUD-06: the copy must not depend on it.
 */
function priceTables(source: readonly Bar[], target: readonly Bar[]) {
  const stored = new Map(target.map((bar) => [bar.date, bar]));
  const calls: string[] = [];
  const port: MirrorPort<Bar> = {
    async readSourcePage(skip, take) {
      calls.push(`read(${skip},${take})`);
      return [...source]
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .slice(skip, skip + take);
    },
    async deleteTargetScope() {
      calls.push("delete");
      const deleted = stored.size;
      stored.clear();
      return deleted;
    },
    async insertTarget(rows) {
      calls.push(`insert(${rows.length})`);
      for (const row of rows) {
        stored.set(row.date, row);
      }
      return rows.length;
    },
  };
  return { port, stored, calls };
}

describe("mirrorTableScope", () => {
  it("removes a row the source no longer has", async () => {
    const { port, stored } = priceTables(
      [{ date: "2026-09-03", close: 10 }],
      [
        { date: "2026-09-03", close: 10 },
        { date: "2026-09-04", close: 11 },
      ],
    );

    const result = await mirrorTableScope(port);

    expect([...stored.keys()]).toEqual(["2026-09-03"]);
    expect(result).toEqual({ inserted: 1, deleted: 2 });
  });

  it("replaces a row the source has corrected", async () => {
    // AUD-06's own example: the matrix copy held ADBE's in-session bar, development the final one.
    const { port, stored } = priceTables(
      [{ date: "2026-09-09", close: 254.86, volume: 4_170_000n }],
      [{ date: "2026-09-09", close: 255.7246, volume: 1_170_000n }],
    );

    await mirrorTableScope(port);

    expect(stored.get("2026-09-09")).toEqual({
      date: "2026-09-09",
      close: 254.86,
      volume: 4_170_000n,
    });
  });

  it("inserts what the target is missing", async () => {
    const { port, stored } = priceTables(
      [
        { date: "2026-09-03", close: 10 },
        { date: "2026-09-04", close: 11 },
      ],
      [],
    );

    const result = await mirrorTableScope(port);

    expect([...stored.keys()]).toEqual(["2026-09-03", "2026-09-04"]);
    expect(result).toEqual({ inserted: 2, deleted: 0 });
  });

  it("empties a scope the source has nothing for", async () => {
    const { port, stored, calls } = priceTables(
      [],
      [{ date: "2026-09-04", close: 11 }],
    );

    const result = await mirrorTableScope(port);

    expect(stored.size).toBe(0);
    expect(result).toEqual({ inserted: 0, deleted: 1 });
    expect(calls).toEqual(["delete", "read(0,2000)"]);
  });

  it("pages the source and stops on a short page", async () => {
    const source = Array.from({ length: 7 }, (_, index) => ({
      date: `2026-09-0${index + 1}`,
      close: index,
    }));
    const { port, stored, calls } = priceTables(source, []);

    const result = await mirrorTableScope(port, 3);

    expect(stored.size).toBe(7);
    expect(result.inserted).toBe(7);
    expect(calls).toEqual([
      "delete",
      "read(0,3)",
      "insert(3)",
      "read(3,3)",
      "insert(3)",
      "read(6,3)",
      "insert(1)",
    ]);
  });
});

type Row = {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: Date;
  readonly ipoDate?: Date | null;
  readonly shares?: bigint;
  readonly values?: unknown;
};

function identityTables(source: readonly Row[], target: readonly Row[]) {
  const stored = new Map(target.map((row) => [row.id, row]));
  const updates: string[] = [];
  const port: IdentityPort<Row> = {
    async readSource() {
      return source;
    },
    async readTarget() {
      return [...stored.values()];
    },
    async insertTarget(rows) {
      for (const row of rows) {
        stored.set(row.id, row);
      }
      return rows.length;
    },
    async updateTarget(row) {
      updates.push(row.id);
      // Prisma rewrites `updatedAt` on every update; the fake does the same.
      stored.set(row.id, {
        ...row,
        updatedAt: new Date("2026-09-22T00:00:00.000Z"),
      });
    },
  };
  return { port, stored, updates };
}

describe("reconcileIdentityRows", () => {
  const at = (iso: string) => new Date(iso);

  it("inserts rows the target does not have", async () => {
    const { port, stored } = identityTables(
      [{ id: "a", name: "Apple", updatedAt: at("2026-01-01T00:00:00.000Z") }],
      [],
    );

    const result = await reconcileIdentityRows(port);

    expect(stored.get("a")?.name).toBe("Apple");
    expect(result).toEqual({ inserted: 1, updated: 0, extra: 0 });
  });

  it("updates a row whose content the source has changed", async () => {
    const { port, stored, updates } = identityTables(
      [
        {
          id: "a",
          name: "Alphabet Inc.",
          updatedAt: at("2026-02-01T00:00:00.000Z"),
        },
      ],
      [
        {
          id: "a",
          name: "Google Inc.",
          updatedAt: at("2026-01-01T00:00:00.000Z"),
        },
      ],
    );

    const result = await reconcileIdentityRows(port);

    expect(stored.get("a")?.name).toBe("Alphabet Inc.");
    expect(updates).toEqual(["a"]);
    expect(result).toEqual({ inserted: 0, updated: 1, extra: 0 });
  });

  it("ignores the fields the write itself rewrites", async () => {
    const { port, updates } = identityTables(
      [{ id: "a", name: "Apple", updatedAt: at("2026-02-01T00:00:00.000Z") }],
      [{ id: "a", name: "Apple", updatedAt: at("2026-01-01T00:00:00.000Z") }],
    );

    const result = await reconcileIdentityRows(port);

    expect(updates).toEqual([]);
    expect(result.updated).toBe(0);
  });

  it("sees no difference in equal dates, bigints and JSON documents", async () => {
    const row = (id: string): Row => ({
      id,
      name: "Apple",
      updatedAt: at("2026-01-01T00:00:00.000Z"),
      ipoDate: at("1980-12-12T00:00:00.000Z"),
      shares: 15_000_000_000n,
      values: { revenue: 1, nested: { a: null, b: [1, 2] } },
    });
    const { port, updates } = identityTables([row("a")], [row("a")]);

    await reconcileIdentityRows(port);

    expect(updates).toEqual([]);
  });

  it("reports rows only the target has and leaves them alone", async () => {
    const { port, stored } = identityTables(
      [{ id: "a", name: "Apple", updatedAt: at("2026-01-01T00:00:00.000Z") }],
      [
        { id: "a", name: "Apple", updatedAt: at("2026-01-01T00:00:00.000Z") },
        {
          id: "seeded",
          name: "QA placeholder",
          updatedAt: at("2026-01-01T00:00:00.000Z"),
        },
      ],
    );

    const result = await reconcileIdentityRows(port);

    expect(result.extra).toBe(1);
    expect(stored.has("seeded")).toBe(true);
  });
});

describe("discardMatrixProjections", () => {
  const environment = {
    databaseName: "intrinsic_value_matrix",
    databaseUrl: "postgresql://u:p@localhost:5432/intrinsic_value_matrix",
    adminDatabaseUrl: "postgresql://u:p@localhost:5432/postgres",
    sourceDatabaseUrl: "postgresql://u:p@localhost:5432/intrinsic_value",
    redisUrl: "redis://localhost:6379/3",
    redisDb: 3,
  } as unknown as Parameters<typeof discardMatrixProjections>[0];

  it("empties the matrix Redis index and disconnects", async () => {
    const calls: string[] = [];
    const messages: string[] = [];
    await discardMatrixProjections(
      environment,
      (m) => messages.push(m),
      (url) => {
        calls.push(`connect ${url}`);
        return {
          async flushdb() {
            calls.push("flushdb");
          },
          disconnect() {
            calls.push("disconnect");
          },
        };
      },
    );

    expect(calls).toEqual([
      "connect redis://localhost:6379/3",
      "flushdb",
      "disconnect",
    ]);
    expect(messages[0]).toContain("database 3");
  });

  it("refuses when the URL's index is not the one the environment reports", async () => {
    // A client connected to another index would empty a cache that belongs to something else.
    await expect(
      discardMatrixProjections(
        {
          ...environment,
          redisUrl: "redis://localhost:6379/0",
        } as typeof environment,
        () => {},
        () => {
          throw new Error("must not connect");
        },
      ),
    ).rejects.toThrow(/must agree/);
  });

  it("disconnects even when the flush fails", async () => {
    let disconnected = false;
    await expect(
      discardMatrixProjections(
        environment,
        () => {},
        () => ({
          async flushdb() {
            throw new Error("READONLY");
          },
          disconnect() {
            disconnected = true;
          },
        }),
      ),
    ).rejects.toThrow("READONLY");
    expect(disconnected).toBe(true);
  });
});
