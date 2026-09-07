import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardNavigation, useUnsavedChangesGuard } from "./unsaved-changes";

const MESSAGE = "Leave and discard?";

function Guarded({ unsaved }: { readonly unsaved: boolean }) {
  useUnsavedChangesGuard(unsaved, MESSAGE);
  return null;
}

/** A stand-in for the `onNavigate` event Next hands the shell's links. */
function navigation() {
  return { preventDefault: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useUnsavedChangesGuard", () => {
  it("leaves navigation alone when no page has unsaved work", () => {
    const confirm = vi.spyOn(window, "confirm");
    render(<Guarded unsaved={false} />);

    const event = navigation();
    guardNavigation(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("cancels the navigation when the user chooses to stay", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Guarded unsaved />);

    const event = navigation();
    guardNavigation(event);

    expect(confirm).toHaveBeenCalledWith(MESSAGE);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("lets the navigation through when the user chooses to leave", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Guarded unsaved />);

    const event = navigation();
    guardNavigation(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("stops asking once the page is clean again", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = render(<Guarded unsaved />);
    view.rerender(<Guarded unsaved={false} />);

    const event = navigation();
    guardNavigation(event);

    expect(confirm).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("stops asking once the guarded page unmounts", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Guarded unsaved />).unmount();

    const event = navigation();
    guardNavigation(event);

    expect(confirm).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps the native prompt for reload and tab close only while unsaved", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");

    const view = render(<Guarded unsaved />);
    expect(add.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);

    view.rerender(<Guarded unsaved={false} />);
    expect(remove.mock.calls.some(([type]) => type === "beforeunload")).toBe(
      true,
    );
  });
});
