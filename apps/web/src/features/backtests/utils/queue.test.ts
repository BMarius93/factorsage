import { describe, expect, it } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { rateLimited } from "../../../lib/api/__testing__/request-failures";
import { queueFullMessage, queuePositionText } from "./queue";

describe("queuePositionText", () => {
  it("states the runs ahead as an upper bound, with the shared capacity in use", () => {
    expect(queuePositionText({ ahead: 3, executing: 4, capacity: 4 })).toBe(
      "Up to 3 backtests ahead · 4 of 4 slots busy",
    );
    expect(queuePositionText({ ahead: 1, executing: 2, capacity: 4 })).toBe(
      "Up to 1 backtest ahead · 2 of 4 slots busy",
    );
    expect(queuePositionText({ ahead: 1_200, executing: 4, capacity: 4 })).toBe(
      "Up to 1,200 backtests ahead · 4 of 4 slots busy",
    );
  });

  it("never calls a run first in line, even with nothing queued before it", () => {
    // Fair ordering can still start another owner's later run first, so "next" would be a promise.
    const text = queuePositionText({ ahead: 0, executing: 1, capacity: 4 });
    expect(text).toBe("No backtests queued ahead of it · 1 of 4 slots busy");
    expect(text).not.toMatch(/next|first|soon|minute/i);
  });
});

describe("queueFullMessage", () => {
  it("is the API's own sentence for a full queue", () => {
    expect(
      queueFullMessage(
        new ApiError(
          503,
          "Backtests are in high demand right now and the queue is full. Try again in a few minutes.",
          "BACKTEST_QUEUE_FULL",
          undefined,
          60,
        ),
      ),
    ).toBe(
      "Backtests are in high demand right now and the queue is full. Try again in a few minutes.",
    );
  });

  it("keeps the same meaning when the answer has no sentence of its own", () => {
    expect(
      queueFullMessage(new ApiError(503, "", "BACKTEST_QUEUE_FULL")),
    ).toContain("the queue is full");
  });

  it("leaves every other failure to the shared translator", () => {
    expect(queueFullMessage(rateLimited())).toBeUndefined();
    expect(
      queueFullMessage(new ApiError(503, "Service unavailable")),
    ).toBeUndefined();
    expect(queueFullMessage(new Error("network"))).toBeUndefined();
  });
});
