import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBuiltInContent } from "../api/admin-api";
import { BuiltInContentPanel } from "./BuiltInContentPanel";

vi.mock("../api/admin-api", () => ({ fetchBuiltInContent: vi.fn() }));

const fetchMock = vi.mocked(fetchBuiltInContent);

beforeEach(() => {
  fetchMock.mockReset();
});

describe("BuiltInContentPanel", () => {
  it("recovers from a failed load through Try again (UI-028)", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ lists: [], strategies: [], monitors: [] });
    const user = userEvent.setup();
    render(<BuiltInContentPanel />);

    const error = await screen.findByTestId("admin-built-ins-error");
    expect(error.getAttribute("role")).toBe("alert");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("No built-in content yet")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
