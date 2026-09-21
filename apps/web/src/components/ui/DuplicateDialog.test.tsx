import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api/client";
import {
  entitlementRefusal,
  rateLimited,
  RATE_LIMITED_COPY,
  unexpectedFailure,
} from "../../lib/api/__testing__/request-failures";
import { copyNameOf, DuplicateDialog } from "./DuplicateDialog";

function renderDialog(
  overrides: Partial<{
    onDuplicate: (name: string) => Promise<void>;
    onClose: () => void;
    sourceName: string;
  }> = {},
) {
  const onDuplicate = vi.fn(overrides.onDuplicate ?? (() => Promise.resolve()));
  const onClose = vi.fn(overrides.onClose ?? (() => {}));
  render(
    <DuplicateDialog
      thing="list"
      sourceName={overrides.sourceName ?? "Dividend picks"}
      maxNameLength={120}
      onDuplicate={onDuplicate}
      onClose={onClose}
    />,
  );
  return {
    onDuplicate,
    onClose,
    nameInput: screen.getByLabelText("Name") as HTMLInputElement,
  };
}

describe("copyNameOf", () => {
  it("adds the product's ` — Copy` to the trimmed source name", () => {
    expect(copyNameOf("  Dividend picks  ", 120)).toBe("Dividend picks — Copy");
  });

  it("shortens a long source name so the default always fits the name limit", () => {
    const name = copyNameOf("x".repeat(120), 120);
    expect(name).toHaveLength(120);
    expect(name.endsWith("x — Copy")).toBe(true);
    // A name that ends in a space where it is cut does not leave a double space before the dash.
    expect(copyNameOf(`${"x".repeat(112)} yz`, 120)).toBe(
      `${"x".repeat(112)} — Copy`,
    );
  });
});

describe("DuplicateDialog", () => {
  it("opens titled, explained, and with the default name focused and selected", () => {
    const { nameInput } = renderDialog();

    const dialog = screen.getByTestId("duplicate-dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Duplicate list" }),
    ).toBeDefined();
    expect(
      within(dialog).getByText("Create an independent copy that you can edit."),
    ).toBeDefined();
    expect(nameInput.value).toBe("Dividend picks — Copy");
    // Selected, so typing replaces the default and Enter accepts it.
    expect(document.activeElement).toBe(nameInput);
    expect(nameInput.selectionStart).toBe(0);
    expect(nameInput.selectionEnd).toBe(nameInput.value.length);
  });

  it("duplicates under the edited, trimmed name on Enter — once, however often it is pressed", async () => {
    const user = userEvent.setup();
    const { onDuplicate, nameInput } = renderDialog({
      // Never settles, so the dialog stays pending for the rest of the test.
      onDuplicate: () => new Promise<void>(() => {}),
    });

    await user.clear(nameInput);
    await user.type(nameInput, "  My own copy  {Enter}{Enter}");

    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledWith("My own copy");
    const submit = screen.getByRole("button", { name: "Duplicating…" });
    expect(submit).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.click(submit);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it("closes on Cancel without duplicating anything", async () => {
    const { onDuplicate, onClose } = renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDuplicate).not.toHaveBeenCalled();
  });

  it("asks for a name rather than submitting an empty one", async () => {
    const { onDuplicate, nameInput } = renderDialog();

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "   ");
    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));

    expect(screen.getByRole("alert").textContent).toBe("A list needs a name.");
    expect(nameInput.getAttribute("aria-invalid")).toBe("true");
    expect(onDuplicate).not.toHaveBeenCalled();
  });

  it("shows a plan refusal with its way forward, and lets the user try again", async () => {
    const { onDuplicate } = renderDialog({
      onDuplicate: () =>
        Promise.reject(
          entitlementRefusal(
            "ENTITLEMENT_LIST_SYMBOL_LIMIT",
            "Your plan allows 10 stocks per list; this change would make 11",
          ),
        ),
    });

    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));

    expect(
      await screen.findByText(
        "Your plan allows 10 stocks per list; this change would make 11",
      ),
    ).toBeDefined();
    expect(screen.getByTestId("entitlement-see-plans")).toBeDefined();
    const retry = screen.getByRole("button", { name: "Duplicate" });
    expect(retry).toHaveProperty("disabled", false);
    await userEvent.click(retry);
    expect(onDuplicate).toHaveBeenCalledTimes(2);
  });

  it("reads other failures through the product's one translator", async () => {
    const failures: [unknown, string][] = [
      [
        new ApiError(400, "A list name must be at most 120 characters"),
        "A list name must be at most 120 characters",
      ],
      [rateLimited(), RATE_LIMITED_COPY],
      [
        unexpectedFailure(),
        "The list could not be duplicated right now. Try again in a moment.",
      ],
    ];
    for (const [failure, message] of failures) {
      const { unmount } = render(
        <DuplicateDialog
          thing="list"
          sourceName="Dividend picks"
          maxNameLength={120}
          onDuplicate={() => Promise.reject(failure)}
          onClose={() => {}}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));
      expect((await screen.findByRole("alert")).textContent).toBe(message);
      unmount();
    }
  });
});
