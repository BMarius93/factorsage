import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OverflowMenu } from "./OverflowMenu";

function renderMenu(
  overrides: Parameters<typeof OverflowMenu>[0] | null = null,
) {
  const onRename = vi.fn();
  const onDelete = vi.fn();
  render(
    overrides ? (
      <OverflowMenu {...overrides} />
    ) : (
      <OverflowMenu
        label="Dow Jones List"
        items={[
          { label: "Rename", onSelect: onRename },
          {
            label: "Delete",
            tone: "danger",
            separated: true,
            onSelect: onDelete,
          },
        ]}
      />
    ),
  );
  return { onRename, onDelete };
}

describe("OverflowMenu", () => {
  it("names the record it acts on, so a column of triggers is not read identically", () => {
    renderMenu();

    expect(
      screen.getByRole("button", { name: "More actions for Dow Jones List" }),
    ).toBeDefined();
  });

  it("keeps its items out of the accessibility tree until it is opened", async () => {
    const user = userEvent.setup();
    renderMenu();

    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /More actions/ }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDefined();
  });

  it("runs the item's action and closes", async () => {
    const user = userEvent.setup();
    const { onRename } = renderMenu();

    await user.click(screen.getByRole("button", { name: /More actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
  });

  it("reports its open state to assistive technology", async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByRole("button", { name: /More actions/ });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByRole("button", { name: /More actions/ });

    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("marks a destructive item so it reads as destructive once opened", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: /More actions/ }));

    expect(
      screen
        .getByRole("menuitem", { name: "Delete" })
        .getAttribute("data-tone"),
    ).toBe("danger");
    expect(
      screen
        .getByRole("menuitem", { name: "Rename" })
        .getAttribute("data-tone"),
    ).toBeNull();
  });

  it("does not run a disabled item", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <OverflowMenu
        label="Value entries"
        items={[{ label: "Disable", disabled: true, onSelect }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /More actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Disable" }));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders nothing when a record has no maintenance actions", () => {
    render(<OverflowMenu label="Run 019" items={[]} />);

    expect(screen.queryByRole("button")).toBeNull();
  });
});
