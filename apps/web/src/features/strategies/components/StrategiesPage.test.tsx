import {
  emptyStrategyDefinition,
  type StrategyDetailResponse,
  type StrategySummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseFromOverflowMenu,
  findOverflowTrigger,
} from "../../../components/ui/__testing__/overflow-menu";
import { ApiError } from "../../../lib/api/client";
import {
  guestSession,
  signedInSession,
} from "../../auth/__testing__/auth-session";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import {
  deleteStrategy,
  duplicateStrategy,
  fetchStrategies,
  updateStrategy,
} from "../api/strategies-api";
import { StrategiesPage } from "./StrategiesPage";

const push = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

vi.mock("../api/strategies-api", () => ({
  fetchStrategies: vi.fn(),
  updateStrategy: vi.fn(),
  deleteStrategy: vi.fn(),
  duplicateStrategy: vi.fn(),
}));

const useAuthSessionMock = vi.mocked(useAuthSession);
const fetchStrategiesMock = vi.mocked(fetchStrategies);
const updateStrategyMock = vi.mocked(updateStrategy);
const deleteStrategyMock = vi.mocked(deleteStrategy);
const duplicateStrategyMock = vi.mocked(duplicateStrategy);

/** The actions one row's menu offers, in order. Leaves the menu open. */
async function menuActions(
  user: ReturnType<typeof userEvent.setup>,
  entityName: string,
  scope?: HTMLElement,
) {
  const trigger = await findOverflowTrigger(entityName, scope);
  await user.click(trigger);
  const popup = document.getElementById(
    trigger.getAttribute("aria-controls") ?? "",
  );
  return within(popup as HTMLElement)
    .getAllByRole("button")
    .map((button) => button.textContent);
}

function summary(
  id: string,
  name: string,
  overrides: Partial<StrategySummaryResponse> = {},
): StrategySummaryResponse {
  return {
    ownership: "USER",
    canEdit: true,
    id,
    name,
    buyLevelCount: 1,
    sellLevelCount: 0,
    hasFinalExit: false,
    versionNumber: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  push.mockReset();
  fetchStrategiesMock.mockReset();
  updateStrategyMock.mockReset();
  deleteStrategyMock.mockReset();
  duplicateStrategyMock.mockReset();
  useAuthSessionMock.mockReturnValue(signedInSession());
});

function builtIn(id: string, name: string): StrategySummaryResponse {
  return summary(id, name, {
    ownership: "SYSTEM",
    systemKey: "value-and-trend",
    canEdit: false,
  });
}

describe("StrategiesPage", () => {
  it("offers the builder as the only way to create, because a name alone is not a strategy", async () => {
    fetchStrategiesMock.mockResolvedValue([]);
    render(<StrategiesPage />);

    const link = await screen.findByTestId("new-strategy-button");
    expect(link).toHaveProperty("tagName", "A");
    expect(link.getAttribute("href")).toBe("/strategies/new");
    expect(screen.getByTestId("strategies-empty")).toBeDefined();
  });

  it("keeps an empty 'Your strategies' compact so the built-ins under it still show", async () => {
    fetchStrategiesMock.mockResolvedValue([builtIn("b1", "Value & Trend")]);
    render(<StrategiesPage />);

    expect(await screen.findByTestId("strategies-empty")).toBeDefined();
    expect(
      screen.getByText("You haven't created any strategies yet"),
    ).toBeDefined();
    expect(screen.getByTestId("built-in-strategies").textContent).toContain(
      "Value & Trend",
    );
    expect(screen.getAllByTestId("new-strategy-button")).toHaveLength(1);
  });

  it("separates the viewer's own strategies from the built-in ones", async () => {
    fetchStrategiesMock.mockResolvedValue([
      builtIn("b1", "Trend Confirmation"),
      summary("s1", "Deep value"),
    ]);
    render(<StrategiesPage />);

    const own = await screen.findByTestId("your-strategies");
    const builtIns = screen.getByTestId("built-in-strategies");
    expect(own.textContent).toContain("Deep value");
    expect(own.textContent).not.toContain("Trend Confirmation");
    expect(builtIns.textContent).toContain("Trend Confirmation");
    // Your content first.
    expect(own.compareDocumentPosition(builtIns)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // Read-only for a customer: the built-in row can be opened and copied, and changes nothing.
    expect(
      await menuActions(userEvent.setup(), "Trend Confirmation", builtIns),
    ).toEqual(["Duplicate"]);
  });

  it("asks a Guest for an account instead of opening the builder", async () => {
    // The prompt carries the page being read, so signing in comes back to it (UX-003).
    window.history.replaceState(null, "", "/strategies");
    const user = userEvent.setup();
    useAuthSessionMock.mockReturnValue(guestSession());
    fetchStrategiesMock.mockResolvedValue([builtIn("b1", "Value & Trend")]);
    render(<StrategiesPage />);

    expect(await screen.findByTestId("built-in-strategies")).toBeDefined();
    expect(screen.queryByTestId("your-strategies")).toBeNull();

    // A Guest gets a button, not a link that would land them on a page they cannot use.
    const create = screen.getByTestId("new-strategy-button");
    expect(create).toHaveProperty("tagName", "BUTTON");
    await user.click(create);

    const prompt = await screen.findByTestId("sign-in-prompt");
    expect(
      within(prompt).getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login?next=%2Fstrategies");
    expect(
      within(prompt)
        .getByRole("link", { name: "Create an account" })
        .getAttribute("href"),
    ).toBe("/register?next=%2Fstrategies");
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId("strategies-page")).toBeDefined();
  });

  it("renders each strategy's shape from its summary counts alone", async () => {
    fetchStrategiesMock.mockResolvedValue([
      summary("s1", "Deep value", {
        description: "Buy the discount",
        sellLevelCount: 2,
        hasFinalExit: true,
      }),
      summary("s2", "Trend"),
    ]);
    render(<StrategiesPage />);

    expect(await screen.findByText("Deep value")).toBeDefined();
    // One badge per level kind, in the level kind's own tone, and none for a kind it lacks.
    const [deepValue, trend] = screen.getAllByTestId("strategy-levels");
    const badges = (cell: HTMLElement | undefined) =>
      Array.from(cell?.querySelectorAll<HTMLElement>("[data-level]") ?? []).map(
        (badge) => [badge.dataset.level, badge.dataset.tone, badge.textContent],
      );
    expect(badges(deepValue)).toEqual([
      ["BUY", "positive", "1 buy"],
      ["SELL", "negative", "2 sells"],
      ["FINAL_EXIT", "warning", "Final exit"],
    ]);
    expect(badges(trend)).toEqual([["BUY", "positive", "1 buy"]]);
    expect(screen.getByText("Buy the discount")).toBeDefined();
    // The collection never loads a definition.
    expect(fetchStrategiesMock).toHaveBeenCalledTimes(1);
  });

  it("links each card to its builder", async () => {
    fetchStrategiesMock.mockResolvedValue([summary("s1", "Deep value")]);
    render(<StrategiesPage />);

    const link = await screen.findByRole("link", { name: /^Deep value/ });
    expect(link.getAttribute("href")).toBe("/strategies/s1");
  });

  it("renames a strategy without touching its definition", async () => {
    const user = userEvent.setup();
    fetchStrategiesMock.mockResolvedValue([summary("s1", "Old name")]);
    updateStrategyMock.mockResolvedValue(summary("s1", "New name"));
    render(<StrategiesPage />);

    await chooseFromOverflowMenu(user, "Old name", "Rename");
    const input = screen.getByLabelText("Name");
    await user.clear(input);
    await user.type(input, "New name");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(updateStrategyMock).toHaveBeenCalledWith("s1", {
        name: "New name",
        description: null,
      });
    });
    expect(await screen.findByText("New name")).toBeDefined();
  });

  it("deletes a strategy only after confirmation", async () => {
    const user = userEvent.setup();
    fetchStrategiesMock.mockResolvedValue([summary("s1", "Doomed")]);
    deleteStrategyMock.mockResolvedValue();
    render(<StrategiesPage />);

    await chooseFromOverflowMenu(user, "Doomed", "Delete");
    expect(deleteStrategyMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete strategy" }));
    await waitFor(() => expect(deleteStrategyMock).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(screen.queryByText("Doomed")).toBeNull());
  });

  /**
   * A strategy a monitor still watches cannot be deleted: `Monitor.strategyId` is `onDelete:
   * Restrict` and the API answers 409 with what to do about it. Reporting that as a connection
   * problem would send the user to retry something that can never succeed.
   */
  it("shows the domain refusal when a monitor still uses the strategy", async () => {
    const user = userEvent.setup();
    fetchStrategiesMock.mockResolvedValue([summary("s1", "Watched")]);
    deleteStrategyMock.mockRejectedValue(
      new ApiError(
        409,
        "This strategy is used by a monitor. Delete the monitor first.",
      ),
    );
    render(<StrategiesPage />);

    await chooseFromOverflowMenu(user, "Watched", "Delete");
    await user.click(screen.getByRole("button", { name: "Delete strategy" }));

    expect(
      await screen.findByText(
        "This strategy is used by a monitor. Delete the monitor first.",
      ),
    ).toBeDefined();
    // The refusal held, so the strategy is still in the collection.
    expect(screen.getByTestId("strategies-grid").textContent).toContain(
      "Watched",
    );
  });

  it("offers a retry when the collection cannot be loaded", async () => {
    const user = userEvent.setup();
    fetchStrategiesMock.mockRejectedValueOnce(new Error("offline"));
    fetchStrategiesMock.mockResolvedValueOnce([summary("s1", "Recovered")]);
    render(<StrategiesPage />);

    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Recovered")).toBeDefined();
  });

  describe("Duplicate", () => {
    function copyOf(id: string, name: string): StrategyDetailResponse {
      return { ...summary(id, name), definition: emptyStrategyDefinition() };
    }

    it("sits between Rename and Delete in a strategy's menu, and nowhere as a visible button", async () => {
      const user = userEvent.setup();
      fetchStrategiesMock.mockResolvedValue([
        summary("s1", "Deep value"),
        builtIn("b1", "Value & Trend"),
      ]);
      render(<StrategiesPage />);
      await screen.findByText("Deep value");

      expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
      expect(await menuActions(user, "Deep value")).toEqual([
        "Rename",
        "Duplicate",
        "Delete",
      ]);
    });

    it("copies the viewer's own strategy under the name they give it, then opens the copy in the Builder", async () => {
      const user = userEvent.setup();
      fetchStrategiesMock.mockResolvedValue([summary("s1", "Deep value")]);
      duplicateStrategyMock.mockResolvedValue(copyOf("copy-1", "Deeper value"));
      render(<StrategiesPage />);

      await chooseFromOverflowMenu(user, "Deep value", "Duplicate");
      const dialog = screen.getByTestId("duplicate-dialog");
      expect(
        within(dialog).getByRole("heading", { name: "Duplicate strategy" }),
      ).toBeDefined();
      const name = within(dialog).getByLabelText("Name") as HTMLInputElement;
      expect(name.value).toBe("Deep value — Copy");

      await user.clear(name);
      await user.type(name, "Deeper value{Enter}");

      await waitFor(() => {
        expect(push).toHaveBeenCalledWith("/strategies/copy-1");
      });
      expect(duplicateStrategyMock).toHaveBeenCalledWith("s1", {
        name: "Deeper value",
      });
      expect(screen.queryByTestId("duplicate-dialog")).toBeNull();
    });

    it("lets a signed-in customer copy a built-in strategy, which offers nothing else", async () => {
      const user = userEvent.setup();
      fetchStrategiesMock.mockResolvedValue([builtIn("b1", "Value & Trend")]);
      duplicateStrategyMock.mockResolvedValue(
        copyOf("copy-2", "Value & Trend — Copy"),
      );
      render(<StrategiesPage />);
      const builtIns = await screen.findByTestId("built-in-strategies");

      expect(await menuActions(user, "Value & Trend", builtIns)).toEqual([
        "Duplicate",
      ]);
      await user.click(screen.getByRole("button", { name: "Duplicate" }));
      await user.click(
        within(screen.getByTestId("duplicate-dialog")).getByRole("button", {
          name: "Duplicate",
        }),
      );

      await waitFor(() => {
        expect(push).toHaveBeenCalledWith("/strategies/copy-2");
      });
      expect(duplicateStrategyMock).toHaveBeenCalledWith("b1", {
        name: "Value & Trend — Copy",
      });
    });

    it("creates nothing when the dialog is cancelled", async () => {
      const user = userEvent.setup();
      fetchStrategiesMock.mockResolvedValue([summary("s1", "Deep value")]);
      render(<StrategiesPage />);

      await chooseFromOverflowMenu(user, "Deep value", "Duplicate");
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.queryByTestId("duplicate-dialog")).toBeNull();
      expect(duplicateStrategyMock).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });

    it("asks a Guest for an account instead of copying a built-in strategy", async () => {
      window.history.replaceState(null, "", "/strategies");
      const user = userEvent.setup();
      useAuthSessionMock.mockReturnValue(guestSession());
      fetchStrategiesMock.mockResolvedValue([builtIn("b1", "Value & Trend")]);
      render(<StrategiesPage />);
      await screen.findByTestId("built-in-strategies");

      await chooseFromOverflowMenu(user, "Value & Trend", "Duplicate");

      const prompt = await screen.findByTestId("sign-in-prompt");
      expect(
        within(prompt).getByRole("heading", {
          name: "Sign in to duplicate a strategy",
        }),
      ).toBeDefined();
      expect(
        within(prompt)
          .getByRole("link", { name: "Sign in" })
          .getAttribute("href"),
      ).toBe("/login?next=%2Fstrategies");
      expect(screen.queryByTestId("duplicate-dialog")).toBeNull();
      expect(duplicateStrategyMock).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });
  });
});
