import { describe, expect, it } from "vitest";
import {
  CanonicalProtectedTierEligibility,
  REDIS_DESIGNATION_ONLY,
  type ProtectedTierEligibilityEvent,
} from "./protected-tier.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("protected tier eligibility", () => {
  it("admits nothing without a canonical universe", async () => {
    expect((await REDIS_DESIGNATION_ONLY.eligible()).size).toBe(0);
  });

  it("reads the universe once, then serves it while a refresh runs in the background", async () => {
    let now = 0;
    const loads: ReturnType<typeof deferred<string[]>>[] = [];
    const eligibility = new CanonicalProtectedTierEligibility(
      () => {
        const load = deferred<string[]>();
        loads.push(load);
        return load.promise;
      },
      { refreshMs: 1_000, now: () => now },
    );
    // Concurrent first readers share one read.
    const first = eligibility.eligible();
    const second = eligibility.eligible();
    expect(loads).toHaveLength(1);
    loads[0]!.resolve(["b", "a"]);
    const snapshot = await first;
    expect(await second).toBe(snapshot);
    expect([...snapshot].sort()).toEqual(["a", "b"]);

    // Fresh: no read at all.
    now = 999;
    expect(await eligibility.eligible()).toBe(snapshot);
    expect(loads).toHaveLength(1);

    // Stale: the old snapshot answers at once while one refresh replaces it.
    now = 1_000;
    expect(await eligibility.eligible()).toBe(snapshot);
    expect(await eligibility.eligible()).toBe(snapshot);
    expect(loads).toHaveLength(2);
    loads[1]!.resolve(["a", "b", "c"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = await eligibility.eligible();
    expect(next).not.toBe(snapshot);
    expect(next.has("c")).toBe(true);
  });

  it("keeps the same snapshot object while the universe does not change", async () => {
    let now = 0;
    const eligibility = new CanonicalProtectedTierEligibility(
      async () => ["a", "b"],
      { refreshMs: 10, now: () => now },
    );
    const snapshot = await eligibility.eligible();
    now = 100;
    await eligibility.eligible();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await eligibility.eligible()).toBe(snapshot);
  });

  it("fails only the first read when PostgreSQL never answered, and serves the last snapshot after", async () => {
    let now = 0;
    let fail = true;
    const events: ProtectedTierEligibilityEvent["event"][] = [];
    const eligibility = new CanonicalProtectedTierEligibility(
      async () => {
        if (fail) {
          throw new Error("connection refused");
        }
        return ["a"];
      },
      {
        refreshMs: 10,
        now: () => now,
        onEvent: (event) => events.push(event.event),
      },
    );
    await expect(eligibility.eligible()).rejects.toThrow("connection refused");
    fail = false;
    const snapshot = await eligibility.eligible();
    expect(snapshot.has("a")).toBe(true);

    fail = true;
    now = 100;
    expect(await eligibility.eligible()).toBe(snapshot);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await eligibility.eligible()).toBe(snapshot);
    expect(events).toEqual(["load-failed", "loaded", "load-failed"]);
  });
});
