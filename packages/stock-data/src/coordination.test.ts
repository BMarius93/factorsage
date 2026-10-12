import { describe, expect, it } from "vitest";
import { InMemoryLoadCoordinator } from "./coordination.js";

/** A promise and the function that resolves it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("InMemoryLoadCoordinator", () => {
  it("waits for the holder when a call names no wait of its own", async () => {
    const coordinator = new InMemoryLoadCoordinator();
    const holder = gate();
    const order: string[] = [];
    const first = coordinator.run("series", async () => {
      await holder.opened;
      order.push("first");
    });
    const second = coordinator.run("series", async () => {
      order.push("second");
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual([]);
    holder.open();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("gives up after its own wait while the resource stays held, and runs nothing", async () => {
    const coordinator = new InMemoryLoadCoordinator();
    const holder = gate();
    const first = coordinator.run("series", async () => {
      await holder.opened;
    });
    let ran = false;

    const started = Date.now();
    await expect(
      coordinator.run(
        "series",
        async () => {
          ran = true;
        },
        { waitMs: 40 },
      ),
    ).rejects.toThrow("was not had within 40ms");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(ran).toBe(false);

    holder.open();
    await first;
  });

  it("does not let a later caller overtake the holder when one in between gave up", async () => {
    const coordinator = new InMemoryLoadCoordinator();
    const holder = gate();
    const order: string[] = [];
    const first = coordinator.run("series", async () => {
      await holder.opened;
      order.push("first");
    });
    await expect(
      coordinator.run("series", async () => {}, { waitMs: 20 }),
    ).rejects.toThrow();
    const third = coordinator.run("series", async () => {
      order.push("third");
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual([]);
    holder.open();
    await Promise.all([first, third]);
    expect(order).toEqual(["first", "third"]);
  });

  it("takes a free resource at once, whatever wait it was given", async () => {
    const coordinator = new InMemoryLoadCoordinator();
    await expect(
      coordinator.run("series", async () => "done", { waitMs: 5 }),
    ).resolves.toBe("done");
  });

  it("refuses a wait that is not a positive whole number of milliseconds", async () => {
    const coordinator = new InMemoryLoadCoordinator();
    await expect(
      coordinator.run("series", async () => {}, { waitMs: 0 }),
    ).rejects.toThrow("waitMs must be a positive integer");
    // The refused call took no place in the queue: the resource is still free.
    await expect(coordinator.run("series", async () => "free")).resolves.toBe(
      "free",
    );
  });
});
