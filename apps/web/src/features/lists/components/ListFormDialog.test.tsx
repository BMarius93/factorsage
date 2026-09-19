import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  entitlementRefusal,
  rateLimited,
  RATE_LIMITED_COPY,
  unexpectedFailure,
} from "../../../lib/api/__testing__/request-failures";
import { createStockList, updateStockList } from "../api/stock-lists-api";
import { ListFormDialog } from "./ListFormDialog";

vi.mock("../api/stock-lists-api", () => ({
  createStockList: vi.fn(),
  updateStockList: vi.fn(),
}));

// The catalog search is its own component with its own tests; this file is about what the dialog
// says when the save is refused.
vi.mock("./SecurityMultiSelect", () => ({
  SecurityMultiSelect: () => <div data-testid="security-multi-select" />,
}));

const createStockListMock = vi.mocked(createStockList);
const updateStockListMock = vi.mocked(updateStockList);

const FALLBACK =
  "The list could not be saved right now. Try again in a moment.";

async function submitCreate() {
  render(
    <ListFormDialog mode="create" onCreated={vi.fn()} onClose={vi.fn()} />,
  );
  await userEvent.type(screen.getByLabelText("Name"), "Too many stocks");
  await userEvent.click(screen.getByRole("button", { name: "Create list" }));
  return screen.findByRole("alert");
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ListFormDialog failures (UX-001)", () => {
  it("shows the plan's own message when a list would exceed the symbol limit", async () => {
    createStockListMock.mockRejectedValue(
      entitlementRefusal(
        "ENTITLEMENT_LIST_SYMBOL_LIMIT",
        "Your plan allows 10 stocks per list; this list would have 11.",
      ),
    );

    const alert = await submitCreate();

    // The plan's own sentence, with a way forward rather than a dead end (UI-020).
    expect(alert.textContent).toContain(
      "Your plan allows 10 stocks per list; this list would have 11.",
    );
    expect(
      within(alert)
        .getByRole("link", { name: "See plans" })
        .getAttribute("href"),
    ).toBe("/billing");
    expect(alert.textContent).not.toContain("Try again in a moment");
    // The dialog stays open with the input intact, so the user can remove a stock and retry.
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Too many stocks",
    );
  });

  it("reads a 429 as a wait, not as an outage to retry immediately", async () => {
    createStockListMock.mockRejectedValue(rateLimited());

    expect((await submitCreate()).textContent).toBe(RATE_LIMITED_COPY);
  });

  it("keeps its own fallback for a genuinely unexpected failure", async () => {
    createStockListMock.mockRejectedValue(unexpectedFailure());

    expect((await submitCreate()).textContent).toBe(FALLBACK);
  });

  it("uses the same translation when renaming", async () => {
    updateStockListMock.mockRejectedValue(
      entitlementRefusal("ENTITLEMENT_RESOURCE_OVER_LIMIT", "Over your plan."),
    );
    render(
      <ListFormDialog
        mode="rename"
        list={{ id: "list-1", name: "Mine" }}
        onUpdated={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Over your plan.");
    // Renaming cannot be fixed by removing stocks, so no such advice is offered here.
    expect(alert.textContent).not.toContain("Remove stocks");
  });
});
