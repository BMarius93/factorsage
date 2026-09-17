import { describe, expect, it } from "vitest";
import { formatAge, freshnessLabel, levelLabel } from "./format";

describe("dashboard formatting", () => {
  const now = new Date("2026-09-17T12:00:00.000Z");

  it("labels a level with its percentage when it has one", () => {
    expect(levelLabel({ levelKind: "BUY", levelPercentage: 100 })).toBe(
      "Buy 100%",
    );
    expect(levelLabel({ levelKind: "FINAL_EXIT" })).toBe("Final exit");
  });

  it("says how old a scan is, and never calls a stale one current", () => {
    expect(formatAge("2026-09-17T11:59:40.000Z", now)).toBe("just now");
    expect(formatAge("2026-09-17T11:56:00.000Z", now)).toBe("4 min ago");
    expect(formatAge("2026-09-17T09:00:00.000Z", now)).toBe("3 h ago");
    expect(freshnessLabel("CURRENT", "2026-09-17T11:56:00.000Z", now)).toBe(
      "Updated 4 min ago",
    );
    expect(freshnessLabel("STALE", "2026-09-15T12:00:00.000Z", now)).toBe(
      "Stale · last scan 2 days ago",
    );
    expect(freshnessLabel("NOT_SCANNED", undefined, now)).toBe(
      "Not scanned yet",
    );
    expect(freshnessLabel("PAUSED", "2026-09-17T11:56:00.000Z", now)).toBe(
      "Paused",
    );
  });
});
