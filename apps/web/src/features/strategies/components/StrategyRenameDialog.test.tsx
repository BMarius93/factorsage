import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import {
  entitlementRefusal,
  rateLimited,
  RATE_LIMITED_COPY,
  unexpectedFailure,
} from "../../../lib/api/__testing__/request-failures";
import { updateStrategy } from "../api/strategies-api";
import { StrategyRenameDialog } from "./StrategyRenameDialog";

vi.mock("../api/strategies-api", () => ({
  updateStrategy: vi.fn(),
}));

const updateStrategyMock = vi.mocked(updateStrategy);

async function saveWith(error: unknown) {
  updateStrategyMock.mockRejectedValue(error);
  render(
    <StrategyRenameDialog
      strategy={{ id: "s1", name: "Deep value" }}
      onUpdated={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  return (await screen.findByRole("alert")).textContent;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("StrategyRenameDialog failures (UX-001)", () => {
  it("shows a plan refusal in the API's words", async () => {
    expect(
      await saveWith(
        entitlementRefusal(
          "ENTITLEMENT_RESOURCE_OVER_LIMIT",
          "Over your plan.",
        ),
      ),
    ).toBe("Over your plan.");
  });

  it("reads a 429 as a wait", async () => {
    expect(await saveWith(rateLimited())).toBe(RATE_LIMITED_COPY);
  });

  it("still shows a validation message verbatim", async () => {
    expect(await saveWith(new ApiError(400, "Name is too long"))).toBe(
      "Name is too long",
    );
  });

  it("keeps its own fallback for anything unexpected", async () => {
    expect(await saveWith(unexpectedFailure())).toBe(
      "The strategy could not be saved right now. Try again in a moment.",
    );
  });
});
