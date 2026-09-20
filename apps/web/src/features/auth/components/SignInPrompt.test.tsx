import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInPrompt } from "./SignInPrompt";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

function renderPrompt(onClose = vi.fn()) {
  render(
    <SignInPrompt
      title="Sign in to run a backtest"
      body="You will come straight back here."
      onClose={onClose}
    />,
  );
  return onClose;
}

describe("SignInPrompt (UX-003)", () => {
  it("carries the page being read, path and query, on both links", () => {
    const here = "/monitors/m-1?tab=signals&from=dashboard";
    window.history.replaceState(null, "", here);
    renderPrompt();

    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe(`/login?next=${encodeURIComponent(here)}`);
    expect(
      screen
        .getByRole("link", { name: "Create an account" })
        .getAttribute("href"),
    ).toBe(`/register?next=${encodeURIComponent(here)}`);
  });

  it("carries nothing from the Dashboard, which is already the default", () => {
    window.history.replaceState(null, "", "/");
    renderPrompt();

    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login");
  });

  it("closes without navigating", async () => {
    window.history.replaceState(null, "", "/strategies/s-1");
    const onClose = renderPrompt();

    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/strategies/s-1");
  });
});
