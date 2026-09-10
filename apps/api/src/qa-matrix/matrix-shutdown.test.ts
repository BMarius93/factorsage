import { describe, expect, it } from "vitest";
import {
  createInterruptHandler,
  INTERRUPTED_EXIT_CODE,
  type MatrixShutdownPorts,
} from "./matrix-shutdown";

/**
 * An interrupt must not outrun the shutdown it started.
 *
 * The pools are detached process groups, so nothing else will clean them up: if the runner exits
 * while `stop()` is still killing one, that group keeps claiming from the matrix queue and the
 * next sweep silently shares its work with it.
 */

function ports(overrides: Partial<MatrixShutdownPorts> = {}): {
  ports: MatrixShutdownPorts;
  events: string[];
  exitCode: () => number | null;
} {
  const events: string[] = [];
  let code: number | null = null;
  return {
    events,
    exitCode: () => code,
    ports: {
      stopPool: async () => {
        events.push("stop:start");
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push("stop:done");
      },
      closeResources: async () => {
        events.push("close");
      },
      log: (message) => events.push(`log:${message.split(";")[0]}`),
      exit: (value) => {
        events.push(`exit:${value}`);
        code = value;
      },
      ...overrides,
    },
  };
}

describe("interrupting a sweep", () => {
  it("exits only after the pool has actually stopped", async () => {
    const harness = ports();
    await createInterruptHandler(harness.ports)("SIGINT");
    expect(harness.events).toEqual([
      "log:Received SIGINT",
      "stop:start",
      "stop:done",
      "close",
      `exit:${INTERRUPTED_EXIT_CODE}`,
    ]);
  });

  it("does not start a second shutdown, and the second caller waits for the first", async () => {
    const harness = ports();
    const handle = createInterruptHandler(harness.ports);
    await Promise.all([handle("SIGINT"), handle("SIGTERM")]);
    expect(harness.events.filter((e) => e === "stop:start")).toHaveLength(1);
    expect(harness.events.filter((e) => e.startsWith("exit:"))).toHaveLength(1);
    // The second signal is acknowledged rather than acted on.
    expect(harness.events).toContain("log:Already shutting down");
  });

  it("reports a failed shutdown and exits non-zero instead of claiming a clean interrupt", async () => {
    const harness = ports({
      stopPool: async () => {
        throw new Error("process group 4242 is still running after SIGKILL");
      },
    });
    await createInterruptHandler(harness.ports)("SIGINT");
    expect(harness.exitCode()).toBe(1);
    expect(harness.events.join("\n")).toContain("could not be stopped cleanly");
    // And the resources are still released.
    expect(harness.events).toContain("close");
  });

  it("still exits when releasing resources fails", async () => {
    const harness = ports({
      closeResources: async () => {
        throw new Error("connection already closed");
      },
    });
    await createInterruptHandler(harness.ports)("SIGINT");
    expect(harness.exitCode()).toBe(INTERRUPTED_EXIT_CODE);
  });
});
