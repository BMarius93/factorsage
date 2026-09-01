import type { StockListItemResponse } from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { replaceBuyWindows } from "../api/stock-lists-api";
import { BuyWindowEditor } from "./BuyWindowEditor";

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

function customItem(): StockListItemResponse {
  return {
    ...fullItem(),
    buyWindowMode: "CUSTOM",
    buyWindows: [
      { startDate: "2020-01-01", endDate: "2020-12-31" },
      { startDate: "2023-01-01", endDate: null },
    ],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("BuyWindowEditor", () => {
  it("shows the persisted canonical ranges when opening a CUSTOM item", () => {
    render(
      <BuyWindowEditor
        listId="list-1"
        item={customItem()}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByDisplayValue("2020-01-01")).toBeDefined();
    expect(screen.getByDisplayValue("2020-12-31")).toBeDefined();
    expect(screen.getByDisplayValue("2023-01-01")).toBeDefined();
    const custom = screen.getByRole("radio", { name: /Custom windows/ });
    expect((custom as HTMLInputElement).checked).toBe(true);
  });

  it("blocks saving CUSTOM ranges with a missing start or inverted dates", async () => {
    render(
      <BuyWindowEditor
        listId="list-1"
        item={fullItem()}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: /Custom windows/ }));
    await userEvent.click(screen.getByTestId("save-buy-windows"));

    expect(screen.getByText("Pick a start date")).toBeDefined();
    expect(replaceBuyWindowsMock).not.toHaveBeenCalled();

    await userEvent.type(
      screen.getByLabelText("Range 1 start date"),
      "2021-01-01",
    );
    await userEvent.type(
      screen.getByLabelText("Range 1 end date"),
      "2020-01-01",
    );
    await userEvent.click(screen.getByTestId("save-buy-windows"));

    expect(
      screen.getByText("The end date is before the start date"),
    ).toBeDefined();
    expect(replaceBuyWindowsMock).not.toHaveBeenCalled();
  });

  it("hints that touching ranges will be merged", async () => {
    render(
      <BuyWindowEditor
        listId="list-1"
        item={fullItem()}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: /Custom windows/ }));
    await userEvent.type(
      screen.getByLabelText("Range 1 start date"),
      "2020-01-01",
    );
    await userEvent.type(
      screen.getByLabelText("Range 1 end date"),
      "2020-12-31",
    );
    await userEvent.click(screen.getByText("+ Add range"));
    await userEvent.type(
      screen.getByLabelText("Range 2 start date"),
      "2021-01-01",
    );

    expect(
      screen.getByText(
        "Overlapping or back-to-back ranges are saved as one continuous window.",
      ),
    ).toBeDefined();
  });

  it("submits open-ended ranges as null and hands the canonical response to onSaved", async () => {
    const saved = vi.fn();
    replaceBuyWindowsMock.mockResolvedValue({
      ...fullItem(),
      buyWindowMode: "CUSTOM",
      buyWindows: [{ startDate: "2020-01-01", endDate: null }],
    });

    render(
      <BuyWindowEditor
        listId="list-1"
        item={fullItem()}
        onSaved={saved}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: /Custom windows/ }));
    await userEvent.type(
      screen.getByLabelText("Range 1 start date"),
      "2020-01-01",
    );
    await userEvent.click(screen.getByTestId("save-buy-windows"));

    await waitFor(() => {
      expect(replaceBuyWindowsMock).toHaveBeenCalledWith("list-1", "item-1", {
        mode: "CUSTOM",
        ranges: [{ startDate: "2020-01-01", endDate: null }],
      });
    });
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({
        buyWindowMode: "CUSTOM",
        buyWindows: [{ startDate: "2020-01-01", endDate: null }],
      }),
    );
  });

  it("switching a CUSTOM item to FULL submits zero ranges", async () => {
    const saved = vi.fn();
    replaceBuyWindowsMock.mockResolvedValue(fullItem());

    render(
      <BuyWindowEditor
        listId="list-1"
        item={customItem()}
        onSaved={saved}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: /Full history/ }));
    await userEvent.click(screen.getByTestId("save-buy-windows"));

    await waitFor(() => {
      expect(replaceBuyWindowsMock).toHaveBeenCalledWith("list-1", "item-1", {
        mode: "FULL",
        ranges: [],
      });
    });
    expect(saved).toHaveBeenCalled();
  });

  it("shows the API's message when the server rejects the configuration", async () => {
    replaceBuyWindowsMock.mockRejectedValue(
      new ApiError(400, "A buy window cannot end before it starts"),
    );

    render(
      <BuyWindowEditor
        listId="list-1"
        item={fullItem()}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: /Custom windows/ }));
    await userEvent.type(
      screen.getByLabelText("Range 1 start date"),
      "2020-01-01",
    );
    await userEvent.click(screen.getByTestId("save-buy-windows"));

    await waitFor(() => {
      expect(
        screen.getByText("A buy window cannot end before it starts"),
      ).toBeDefined();
    });
  });
});
