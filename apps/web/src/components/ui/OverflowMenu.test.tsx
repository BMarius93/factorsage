import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OverflowMenu } from "./OverflowMenu";

function renderMenu() {
  const onRename = vi.fn();
  const onDelete = vi.fn();
  render(
    <>
      <button type="button">before</button>
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
      <button type="button">after</button>
    </>,
  );
  return { onRename, onDelete };
}

const trigger = () => screen.getByRole("button", { name: /More actions/ });

/** The popup the trigger actually controls, rather than anything else on the page. */
function popup() {
  const id = trigger().getAttribute("aria-controls");
  expect(id).toBeTruthy();
  const element = document.getElementById(id as string);
  expect(element).not.toBeNull();
  return within(element as HTMLElement);
}

describe("OverflowMenu", () => {
  it("names the record it acts on, so a column of triggers is not read identically", () => {
    renderMenu();

    expect(
      screen.getByRole("button", { name: "More actions for Dow Jones List" }),
    ).toBeDefined();
  });

  it("keeps its actions out of the accessibility tree until it is opened", async () => {
    const user = userEvent.setup();
    renderMenu();

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    await user.click(trigger());
    expect(popup().getByRole("button", { name: "Delete" })).toBeDefined();
  });

  it("runs the action once and closes", async () => {
    const user = userEvent.setup();
    const { onRename } = renderMenu();

    await user.click(trigger());
    await user.click(popup().getByRole("button", { name: "Rename" }));

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("marks a destructive action so it reads as destructive once opened", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(trigger());

    expect(
      popup().getByRole("button", { name: "Delete" }).getAttribute("data-tone"),
    ).toBe("danger");
    expect(
      popup().getByRole("button", { name: "Rename" }).getAttribute("data-tone"),
    ).toBeNull();
  });

  it("does not run a disabled action", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <OverflowMenu
        label="Value entries"
        items={[{ label: "Disable", disabled: true, onSelect }]}
      />,
    );

    await user.click(trigger());
    const action = popup().getByRole("button", { name: "Disable" });
    expect(action.hasAttribute("disabled")).toBe(true);

    await user.click(action);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes when a pointer lands outside it", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(trigger());
    expect(popup().getByRole("button", { name: "Rename" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: "after" }));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("renders nothing when a record has no maintenance actions", () => {
    render(<OverflowMenu label="Run 019" items={[]} />);

    expect(screen.queryByRole("button")).toBeNull();
  });
});

/**
 * This is a disclosure, not an ARIA menu: no `role="menu"`, and therefore no promise of
 * arrow-key roving focus. What it does promise is that the trigger reports its state and
 * that the revealed actions sit in the natural tab order — so that is what is asserted.
 */
describe("OverflowMenu keyboard and semantics", () => {
  it("is a disclosure rather than a menu it does not implement", async () => {
    const user = userEvent.setup();
    renderMenu();

    expect(trigger().getAttribute("aria-haspopup")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("reports its open state on the trigger and links it to the popup", async () => {
    const user = userEvent.setup();
    renderMenu();

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-controls")).toBeNull();

    await user.click(trigger());

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const id = trigger().getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(document.getElementById(id as string)).not.toBeNull();
  });

  it("is reachable by keyboard and opens on Enter", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "before" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(trigger());

    await user.keyboard("{Enter}");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("opens on Space", async () => {
    const user = userEvent.setup();
    renderMenu();

    trigger().focus();
    await user.keyboard(" ");

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("puts the actions in the natural tab order, in visible order", async () => {
    const user = userEvent.setup();
    renderMenu();

    trigger().focus();
    await user.keyboard("{Enter}");

    await user.tab();
    expect(document.activeElement).toBe(
      popup().getByRole("button", { name: "Rename" }),
    );

    await user.tab();
    expect(document.activeElement).toBe(
      popup().getByRole("button", { name: "Delete" }),
    );
  });

  it("runs the focused action on Enter and closes", async () => {
    const user = userEvent.setup();
    const { onRename } = renderMenu();

    trigger().focus();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.keyboard("{Enter}");

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("Shift+Tab walks back out to the trigger", async () => {
    const user = userEvent.setup();
    renderMenu();

    trigger().focus();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(document.activeElement).toBe(
      popup().getByRole("button", { name: "Rename" }),
    );

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(trigger());
  });

  it("closes when focus leaves the last action", async () => {
    const user = userEvent.setup();
    renderMenu();

    trigger().focus();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.tab();
    await user.tab();

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "after" }),
    );
  });

  it("skips a disabled action, because a disabled button takes no tab stop", async () => {
    const user = userEvent.setup();
    render(
      <>
        <OverflowMenu
          label="Value entries"
          items={[
            { label: "Disable", disabled: true, onSelect: vi.fn() },
            { label: "Delete", onSelect: vi.fn() },
          ]}
        />
        <button type="button">after</button>
      </>,
    );

    trigger().focus();
    await user.keyboard("{Enter}");
    await user.tab();

    expect(document.activeElement).toBe(
      popup().getByRole("button", { name: "Delete" }),
    );
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(trigger());
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Escape from inside the popup, and focus lands back on the trigger", async () => {
    const user = userEvent.setup();
    renderMenu();

    trigger().focus();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
