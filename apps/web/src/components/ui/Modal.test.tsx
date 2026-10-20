import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Modal } from "./Modal";
import { OverflowMenu } from "./OverflowMenu";

function FormDialogHarness({ removeOpenerOnClose = false }) {
  const [open, setOpen] = useState(false);
  const [openerPresent, setOpenerPresent] = useState(true);
  return (
    <main id="main-content" tabIndex={-1}>
      {openerPresent ? (
        <button type="button" onClick={() => setOpen(true)}>
          New list
        </button>
      ) : null}
      {open ? (
        <Modal
          title="New list"
          onClose={() => {
            setOpen(false);
            if (removeOpenerOnClose) {
              setOpenerPresent(false);
            }
          }}
        >
          <label htmlFor="name">Name</label>
          <input id="name" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              if (removeOpenerOnClose) {
                setOpenerPresent(false);
              }
            }}
          >
            Cancel
          </button>
        </Modal>
      ) : null}
    </main>
  );
}

describe("Modal focus management (GL-2)", () => {
  it("opens on the body's first field rather than the close button", async () => {
    const user = userEvent.setup();
    render(<FormDialogHarness />);
    await user.click(screen.getByRole("button", { name: "New list" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });

  it("opens a confirmation without fields on its first action", async () => {
    function Confirm() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Delete
          </button>
          {open ? (
            <Modal title="Delete list?" onClose={() => setOpen(false)}>
              <p>This cannot be undone.</p>
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button">Delete list</button>
            </Modal>
          ) : null}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Confirm />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
  });

  it.each([
    [
      "Cancel",
      (/* the body's own button */) =>
        screen.getByRole("button", { name: "Cancel" }),
    ],
    [
      "the close button",
      () => screen.getByRole("button", { name: "Close dialog" }),
    ],
  ])("returns focus to the opener after %s", async (_label, control) => {
    const user = userEvent.setup();
    render(<FormDialogHarness />);
    const opener = screen.getByRole("button", { name: "New list" });
    await user.click(opener);
    await user.click(control());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("returns focus to the opener after Escape", async () => {
    const user = userEvent.setup();
    render(<FormDialogHarness />);
    const opener = screen.getByRole("button", { name: "New list" });
    await user.click(opener);
    // jsdom does not turn Escape into the dialog's `cancel` event; the browser does.
    fireEvent(
      document.querySelector("dialog") as HTMLDialogElement,
      new Event("cancel", { cancelable: true }),
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("falls back to the main content when the opener no longer exists", async () => {
    const user = userEvent.setup();
    render(<FormDialogHarness removeOpenerOnClose />);
    await user.click(screen.getByRole("button", { name: "New list" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("main-content"),
    );
  });

  it("returns focus to an overflow menu's trigger when the menu item opened the dialog", async () => {
    function MenuHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <OverflowMenu
            label="Blue chips"
            items={[{ label: "Rename", onSelect: () => setOpen(true) }]}
          />
          {open ? (
            <Modal title="Rename list" onClose={() => setOpen(false)}>
              <label htmlFor="rename">Name</label>
              <input id="rename" />
            </Modal>
          ) : null}
        </>
      );
    }
    const user = userEvent.setup();
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", {
      name: "More actions for Blue chips",
    });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
