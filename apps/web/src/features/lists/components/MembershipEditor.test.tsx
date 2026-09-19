import type { StockListItemResponse } from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import {
  entitlementRefusal,
  rateLimited,
  RATE_LIMITED_COPY,
  unexpectedFailure,
} from "../../../lib/api/__testing__/request-failures";
import { replaceBuyWindows } from "../api/stock-lists-api";
import { MembershipEditor } from "./MembershipEditor";

vi.mock("../api/stock-lists-api", () => ({
  replaceBuyWindows: vi.fn(),
}));

const replaceBuyWindowsMock = vi.mocked(replaceBuyWindows);

function fullItem(): StockListItemResponse {
  return {
    id: "item-1",
    security: {
      id: "sec-1",
      symbol: "NVDA",
      name: "NVIDIA Corporation",
      exchangeCode: "NASDAQ",
    },
    buyWindowMode: "FULL",
    buyWindows: [],
  };
}

function withWindows(
  buyWindows: StockListItemResponse["buyWindows"],
): StockListItemResponse {
  return { ...fullItem(), buyWindowMode: "CUSTOM", buyWindows };
}

function mount(item: StockListItemResponse, onSaved = vi.fn()) {
  render(
    <MembershipEditor
      listId="list-1"
      item={item}
      onSaved={onSaved}
      onClose={() => {}}
    />,
  );
  return onSaved;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("MembershipEditor", () => {
  it("opens an open-ended member with its start date and Present chosen", () => {
    mount(withWindows([{ startDate: "1982-11-30", endDate: null }]));

    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe(
      "1982-11-30",
    );
    expect((screen.getByLabelText("Present") as HTMLInputElement).checked).toBe(
      true,
    );
    // An open-ended membership has no end date to edit, so the control says so rather than
    // showing an empty field that looks unfilled.
    expect((screen.getByLabelText("To") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId("membership-preview").textContent).toContain(
      "Nov 30, 1982 → Present",
    );
  });

  it("opens a bounded member with both dates and Present unchecked", () => {
    mount(withWindows([{ startDate: "2001-03-10", endDate: "2008-07-15" }]));

    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe(
      "2008-07-15",
    );
    expect((screen.getByLabelText("Present") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(screen.getByTestId("membership-preview").textContent).toContain(
      "Mar 10, 2001 → Jul 15, 2008",
    );
  });

  it("exposes exactly one period — there is no way to add a second", () => {
    mount(withWindows([{ startDate: "2001-03-10", endDate: "2008-07-15" }]));

    expect(screen.getAllByLabelText("From")).toHaveLength(1);
    expect(screen.getAllByLabelText("To")).toHaveLength(1);
    expect(screen.queryByText(/Add (another|range|period)/i)).toBeNull();
  });

  it("clears and re-enables the end date as Present is toggled", async () => {
    mount(withWindows([{ startDate: "2001-03-10", endDate: "2008-07-15" }]));

    await userEvent.click(screen.getByLabelText("Present"));
    expect((screen.getByLabelText("To") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId("membership-preview").textContent).toContain(
      "Mar 10, 2001 → Present",
    );

    await userEvent.click(screen.getByLabelText("Present"));
    const to = screen.getByLabelText("To") as HTMLInputElement;
    expect(to.disabled).toBe(false);
    // Un-ticking Present asks for a real end date rather than silently restoring the old one.
    expect(to.value).toBe("");
  });

  it("refuses to save an end date before the start and does not call the API", async () => {
    mount(withWindows([{ startDate: "2020-01-01", endDate: "2020-12-31" }]));

    await userEvent.clear(screen.getByLabelText("To"));
    await userEvent.type(screen.getByLabelText("To"), "2019-01-01");
    await userEvent.click(screen.getByTestId("save-membership"));

    const message = screen.getByTestId("membership-validation");
    expect(message.textContent).toBe("Membership cannot end before it starts.");
    expect(screen.getByLabelText("To").getAttribute("aria-invalid")).toBe(
      "true",
    );
    // The message is wired to the field it belongs to, not floating beside the form.
    expect(screen.getByLabelText("To").getAttribute("aria-describedby")).toBe(
      message.id,
    );
    expect(replaceBuyWindowsMock).not.toHaveBeenCalled();
  });

  it("requires a start date before saving a period", async () => {
    mount(fullItem());

    await userEvent.click(
      screen.getByRole("radio", { name: /Membership period/ }),
    );
    await userEvent.click(screen.getByTestId("save-membership"));

    expect(screen.getByTestId("membership-validation").textContent).toBe(
      "Pick the date membership starts.",
    );
    expect(replaceBuyWindowsMock).not.toHaveBeenCalled();
  });

  it("requires an end date once Present is unticked", async () => {
    mount(fullItem());

    await userEvent.click(
      screen.getByRole("radio", { name: /Membership period/ }),
    );
    await userEvent.type(screen.getByLabelText("From"), "2020-01-01");
    await userEvent.click(screen.getByLabelText("Present"));
    await userEvent.click(screen.getByTestId("save-membership"));

    expect(screen.getByTestId("membership-validation").textContent).toBe(
      "Pick the date membership ends, or choose Present.",
    );
    expect(replaceBuyWindowsMock).not.toHaveBeenCalled();
  });

  it("submits Present as an explicit null end date", async () => {
    const saved = vi.fn();
    replaceBuyWindowsMock.mockResolvedValue(
      withWindows([{ startDate: "1982-11-30", endDate: null }]),
    );
    mount(fullItem(), saved);

    await userEvent.click(
      screen.getByRole("radio", { name: /Membership period/ }),
    );
    await userEvent.type(screen.getByLabelText("From"), "1982-11-30");
    await userEvent.click(screen.getByTestId("save-membership"));

    await waitFor(() => {
      expect(replaceBuyWindowsMock).toHaveBeenCalledWith("list-1", "item-1", {
        mode: "CUSTOM",
        ranges: [{ startDate: "1982-11-30", endDate: null }],
      });
    });
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({
        buyWindows: [{ startDate: "1982-11-30", endDate: null }],
      }),
    );
  });

  it("switching to always eligible submits zero ranges", async () => {
    replaceBuyWindowsMock.mockResolvedValue(fullItem());
    const saved = mount(
      withWindows([{ startDate: "2020-01-01", endDate: null }]),
    );

    await userEvent.click(
      screen.getByRole("radio", { name: /Always eligible/ }),
    );
    await userEvent.click(screen.getByTestId("save-membership"));

    await waitFor(() => {
      expect(replaceBuyWindowsMock).toHaveBeenCalledWith("list-1", "item-1", {
        mode: "FULL",
        ranges: [],
      });
    });
    expect(saved).toHaveBeenCalled();
  });

  it("surfaces the API's own message when the server rejects the period", async () => {
    replaceBuyWindowsMock.mockRejectedValue(
      new ApiError(400, "A buy window cannot end before it starts"),
    );
    mount(withWindows([{ startDate: "2020-01-01", endDate: null }]));

    await userEvent.click(screen.getByTestId("save-membership"));

    await waitFor(() => {
      expect(
        screen.getByText("A buy window cannot end before it starts"),
      ).toBeDefined();
    });
  });

  describe("refusals that are not validation (UX-001)", () => {
    async function saveWith(error: unknown) {
      replaceBuyWindowsMock.mockRejectedValue(error);
      mount(withWindows([{ startDate: "2020-01-01", endDate: null }]));
      await userEvent.click(screen.getByTestId("save-membership"));
      return (await screen.findByRole("alert")).textContent;
    }

    it("shows a plan refusal in the API's words", async () => {
      expect(
        await saveWith(
          entitlementRefusal(
            "ENTITLEMENT_RESOURCE_OVER_LIMIT",
            "This list holds more stocks than your plan allows.",
          ),
        ),
      ).toBe("This list holds more stocks than your plan allows.");
    });

    it("reads a 429 as a wait", async () => {
      expect(await saveWith(rateLimited())).toBe(RATE_LIMITED_COPY);
    });

    it("keeps its own fallback for anything unexpected", async () => {
      expect(await saveWith(unexpectedFailure())).toBe(
        "The membership could not be saved right now. Try again in a moment.",
      );
    });
  });

  describe("a member the API gave more than one period", () => {
    const multi = () =>
      withWindows([
        { startDate: "2001-03-10", endDate: "2008-07-15" },
        { startDate: "2012-05-01", endDate: null },
      ]);

    it("opens read-only, showing every period rather than the first one", () => {
      mount(multi());

      const history = screen.getByTestId("membership-history");
      expect(history.textContent).toContain("Mar 10, 2001 → Jul 15, 2008");
      expect(history.textContent).toContain("May 1, 2012 → Present");
      // No form, so no read/edit/save cycle can flatten [p1, p2] into [p1].
      expect(screen.queryByLabelText("From")).toBeNull();
      expect(screen.queryByTestId("save-membership")).toBeNull();
    });

    it("only offers the single-period form after an explicit instruction", async () => {
      mount(multi());

      await userEvent.click(screen.getByTestId("replace-membership-history"));

      expect(screen.queryByTestId("membership-history")).toBeNull();
      expect(screen.getByTestId("save-membership")).toBeDefined();
      // Seeded from the first period, which is now what an explicit replacement means.
      expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe(
        "2001-03-10",
      );
    });

    it("writes nothing while the guard is up", async () => {
      mount(multi());

      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(replaceBuyWindowsMock).not.toHaveBeenCalled();
    });
  });
});
