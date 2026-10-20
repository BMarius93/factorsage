import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  PASSWORD_HIDDEN_STATUS,
  PASSWORD_SHOWN_STATUS,
  PasswordInput,
} from "./PasswordInput";

function Field({
  onSubmit = () => {},
  disabled = false,
}: {
  readonly onSubmit?: () => void;
  readonly disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor="password">Password</label>
      <PasswordInput
        id="password"
        name="password"
        autoComplete="current-password"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={disabled}
        required
      />
      <button type="submit">Sign in</button>
    </form>
  );
}

const field = () => screen.getByLabelText("Password") as HTMLInputElement;

describe("PasswordInput (AU-1)", () => {
  it("starts hidden, with a button named for what it would do", () => {
    render(<Field />);

    expect(field().type).toBe("password");
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.getAttribute("aria-controls")).toBe("password");
    // The name carries the state, so a pressed state would say it twice — and contradict it.
    expect(toggle.hasAttribute("aria-pressed")).toBe(false);
    // The visible word is part of the accessible name (WCAG 2.5.3).
    expect(toggle.textContent).toContain("Show");
  });

  it("is not a second field labelled Password", () => {
    render(<Field />);
    // Exactly one control answers to the field's label, so `getByLabel("Password")` stays unique.
    expect(screen.getAllByLabelText(/password/i)).toHaveLength(1);
    expect(
      screen
        .getByRole("button", { name: "Show password" })
        .hasAttribute("aria-label"),
    ).toBe(false);
  });

  it("shows and hides the password, keeping the value and the field's attributes", async () => {
    const user = userEvent.setup();
    render(<Field />);
    await user.type(field(), "Local-test-password-42");

    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(field().type).toBe("text");
    expect(field().value).toBe("Local-test-password-42");
    expect(field().getAttribute("autocomplete")).toBe("current-password");
    expect(field().getAttribute("name")).toBe("password");
    expect(
      screen.getByText(PASSWORD_SHOWN_STATUS).getAttribute("aria-live"),
    ).toBe("polite");

    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(field().type).toBe("password");
    expect(field().value).toBe("Local-test-password-42");
    expect(screen.getByText(PASSWORD_HIDDEN_STATUS)).toBeDefined();
    expect(screen.getByRole("button", { name: "Show password" })).toBeDefined();
  });

  it("never submits the form, by pointer or by keyboard", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Field onSubmit={onSubmit} />);
    await user.type(field(), "secret-value");

    await user.click(screen.getByRole("button", { name: "Show password" }));
    const toggle = screen.getByRole("button", { name: "Hide password" });
    toggle.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onSubmit).not.toHaveBeenCalled();
    // Enter, then Space: hidden, then shown again.
    expect(field().type).toBe("text");
    expect(field().value).toBe("secret-value");
  });

  it("is reached and operated from the keyboard, and keeps focus on itself", async () => {
    const user = userEvent.setup();
    render(<Field />);

    await user.tab();
    expect(document.activeElement).toBe(field());
    await user.tab();
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(document.activeElement).toBe(toggle);

    await user.keyboard(" ");
    expect(field().type).toBe("text");
    expect(document.activeElement).toBe(toggle);
  });

  it("leaves focus and the caret in the field when pressed with a pointer", async () => {
    const user = userEvent.setup();
    render(<Field />);
    await user.type(field(), "abcdef");
    field().setSelectionRange(2, 4);

    await user.click(screen.getByRole("button", { name: "Show password" }));

    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe(2);
    expect(field().selectionEnd).toBe(4);

    // Typing carries on where the caret was.
    await user.keyboard("X");
    expect(field().value).toBe("abXef");
  });

  it("hides the password again when the form is submitted", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Field onSubmit={onSubmit} />);
    await user.type(field(), "secret-value");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(field().type).toBe("text");

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(field().type).toBe("password");
    expect(field().value).toBe("secret-value");
    expect(screen.getByRole("button", { name: "Show password" })).toBeDefined();
  });

  it("is disabled with its field", () => {
    render(<Field disabled />);

    expect(field().disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Show password",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
