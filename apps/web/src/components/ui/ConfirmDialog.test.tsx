import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api/client";
import {
  entitlementRefusal,
  rateLimited,
  RATE_LIMITED_COPY,
  unexpectedFailure,
} from "../../lib/api/__testing__/request-failures";
import { ConfirmDialog } from "./ConfirmDialog";

const FALLBACK = "That did not work. Check your connection and try again.";

async function confirmWith(error: unknown) {
  render(
    <ConfirmDialog
      title="Delete list"
      body={<p>Delete it?</p>}
      confirmLabel="Delete list"
      pendingLabel="Deleting…"
      onConfirm={() => Promise.reject(error)}
      onClose={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Delete list" }));
  return (await screen.findByRole("alert")).textContent;
}

describe("ConfirmDialog failures", () => {
  it("passes a 409 dependency refusal through verbatim", async () => {
    expect(
      await confirmWith(
        new ApiError(
          409,
          "This strategy is used by a monitor. Delete the monitor first.",
        ),
      ),
    ).toBe("This strategy is used by a monitor. Delete the monitor first.");
  });

  it("shows a plan refusal in the API's words (UX-001)", async () => {
    expect(
      await confirmWith(
        entitlementRefusal(
          "ENTITLEMENT_FEATURE_UNAVAILABLE",
          "Not on your plan.",
        ),
      ),
    ).toBe("Not on your plan.");
  });

  it("reads a 429 as a wait (UX-001)", async () => {
    expect(await confirmWith(rateLimited())).toBe(RATE_LIMITED_COPY);
  });

  it("keeps its own fallback for an unexpected status", async () => {
    expect(await confirmWith(unexpectedFailure())).toBe(FALLBACK);
  });

  it("keeps its own fallback for a network failure", async () => {
    expect(await confirmWith(new Error("network"))).toBe(FALLBACK);
  });

  it("re-enables its buttons after a refusal so the user can back out", async () => {
    await confirmWith(rateLimited());
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(false);
  });
});
