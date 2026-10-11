import {
  ACTOR_RESOLVE_MAX_IDS,
  type AlternativeDataActorResponse,
} from "@intrinsic/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet } from "../../../lib/api/client";
import { resolveActors } from "./alternative-data-api";

vi.mock("../../../lib/api/client", () => ({ apiGet: vi.fn() }));

const apiGetMock = vi.mocked(apiGet);

function actor(id: string): AlternativeDataActorResponse {
  return {
    id,
    externalId: `X-${id}`,
    displayName: `Member ${id}`,
    chamber: "HOUSE",
  };
}

/** The ids one request named, read back out of its query string. */
function idsOf(path: string): string[] {
  return (new URLSearchParams(path.split("?")[1]).get("ids") ?? "").split(",");
}

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * A rule can select two hundred and fifty members and their ids travel in a query string, so the
 * names are asked for in batches the API accepts — and joined, so a caller never sees the seam.
 */
describe("resolveActors", () => {
  it("asks for nothing when there is nobody to name", async () => {
    await expect(resolveActors([])).resolves.toEqual([]);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("names a small selection in one request", async () => {
    apiGetMock.mockImplementation(async (path) => idsOf(path).map(actor));
    const resolved = await resolveActors(["a", "b", "a"]);
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    // Each id once, however often the caller named it.
    expect(idsOf(apiGetMock.mock.calls[0]![0])).toEqual(["a", "b"]);
    expect(resolved.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("splits a large selection into batches the API accepts, and joins the answers", async () => {
    apiGetMock.mockImplementation(async (path) => idsOf(path).map(actor));
    const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);

    const resolved = await resolveActors(ids);

    expect(apiGetMock).toHaveBeenCalledTimes(250 / ACTOR_RESOLVE_MAX_IDS);
    for (const [path] of apiGetMock.mock.calls) {
      expect(idsOf(path).length).toBeLessThanOrEqual(ACTOR_RESOLVE_MAX_IDS);
      // Short enough for a proxy that caps the request line.
      expect(path.length).toBeLessThan(4_000);
    }
    expect(resolved.map((entry) => entry.id)).toEqual(ids);
  });

  it("leaves an id the catalog does not answer for out of the result", async () => {
    apiGetMock.mockImplementation(async (path) =>
      idsOf(path)
        .filter((id) => id !== "gone")
        .map(actor),
    );
    const resolved = await resolveActors(["a", "gone", "b"]);
    expect(resolved.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});
