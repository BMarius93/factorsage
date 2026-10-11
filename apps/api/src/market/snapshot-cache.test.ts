import { describe, expect, it, vi } from "vitest";
import { SnapshotCache, type SnapshotLoad } from "./snapshot-cache";

function cacheAt(
  start = 0,
  options: { ttlMs?: number; maxStaleMs?: number } = {},
) {
  let now = start;
  const failures: unknown[] = [];
  const cache = new SnapshotCache<string>({
    ttlMs: options.ttlMs ?? 60_000,
    maxStaleMs: options.maxStaleMs ?? 15 * 60_000,
    now: () => now,
    onBackgroundFailure: (error) => failures.push(error),
  });
  return {
    cache,
    failures,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function loader(
  values: string[],
  servableUntil?: (call: number) => number | undefined,
) {
  let call = 0;
  return vi.fn(async (): Promise<SnapshotLoad<string>> => {
    const value = values[Math.min(call, values.length - 1)] as string;
    const until = servableUntil?.(call);
    call += 1;
    return until === undefined ? { value } : { value, servableUntil: until };
  });
}

describe("SnapshotCache", () => {
  it("shares one computation between concurrent callers", async () => {
    const { cache } = cacheAt();
    const load = loader(["a"]);

    const values = await Promise.all([
      cache.get(load),
      cache.get(load),
      cache.get(load),
    ]);

    expect(values).toEqual(["a", "a", "a"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("serves the value inside its TTL, then serves it once more while refreshing it", async () => {
    const { cache, advance } = cacheAt();
    const load = loader(["a", "b"]);
    await cache.get(load);

    advance(59_000);
    expect(await cache.get(load)).toBe("a");
    expect(load).toHaveBeenCalledTimes(1);

    advance(2_000);
    expect(await cache.get(load)).toBe("a");
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(await cache.get(load)).toBe("b");
  });

  it("never serves a value past the staleness bound", async () => {
    const { cache, advance } = cacheAt();
    const load = loader(["a", "b"]);
    await cache.get(load);

    advance(15 * 60_000);
    expect(await cache.get(load)).toBe("b");
  });

  it("lets a computation shorten the bound for a value carrying older data, inside the TTL too", async () => {
    const { cache, advance } = cacheAt(1_000_000);
    // The first value carries a part that may be served only until 1_030_000.
    const load = loader(["a", "b"], (call) =>
      call === 0 ? 1_030_000 : undefined,
    );
    await cache.get(load);

    advance(29_000);
    expect(await cache.get(load)).toBe("a");
    advance(1_000);
    // Still inside the 60-second TTL, but past what the value itself allowed: recomputed, awaited.
    expect(await cache.get(load)).toBe("b");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("fails the request when a value is unservable and the recomputation throws", async () => {
    const { cache, advance } = cacheAt();
    const load = vi
      .fn<() => Promise<SnapshotLoad<string>>>()
      .mockResolvedValueOnce({ value: "a" })
      .mockRejectedValue(new Error("down"));
    await cache.get(load);

    advance(15 * 60_000);
    await expect(cache.get(load)).rejects.toThrow("down");
  });

  it("reports a failed background refresh and keeps serving the previous value within bounds", async () => {
    const { cache, failures, advance } = cacheAt();
    const load = vi
      .fn<() => Promise<SnapshotLoad<string>>>()
      .mockResolvedValueOnce({ value: "a" })
      .mockRejectedValue(new Error("down"));
    await cache.get(load);

    advance(61_000);
    expect(await cache.get(load)).toBe("a");
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(await cache.get(load)).toBe("a");
  });
});
