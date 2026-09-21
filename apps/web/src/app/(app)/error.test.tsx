import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppError from "./error";

const SECRET =
  "Cannot read properties of undefined (reading 'closes') at chart.tsx:42";

function failure(): Error & { digest?: string } {
  const error = new Error(SECRET) as Error & { digest?: string };
  error.digest = "digest-123";
  return error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("(app) error boundary (UX-006)", () => {
  it("shows a safe in-shell error state without the error's message or stack", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = failure();
    const { container } = render(<AppError error={error} reset={vi.fn()} />);

    const state = screen.getByTestId("app-error");
    expect(state.getAttribute("role")).toBe("alert");
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "This page could not be shown",
      }),
    ).toBeDefined();
    expect(container.textContent).not.toContain(SECRET);
    expect(container.textContent).not.toContain("digest-123");
    expect(container.textContent).not.toContain("chart.tsx");
    expect(
      screen
        .getByRole("link", { name: "Go to the Dashboard" })
        .getAttribute("href"),
    ).toBe("/");
    // Logged for whoever is debugging, and only to the console.
    expect(logged).toHaveBeenCalledWith(error);
  });

  it("calls reset exactly once per Try again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reset = vi.fn();
    render(<AppError error={failure()} reset={reset} />);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(reset).toHaveBeenCalledTimes(1);
  });
});
