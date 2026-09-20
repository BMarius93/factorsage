import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import GlobalError from "./global-error";

const SECRET = "RootLayout exploded: secret-token-abc at layout.tsx:12";

function failure(): Error & { digest?: string } {
  const error = new Error(SECRET) as Error & { digest?: string };
  error.digest = "digest-456";
  return error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("global-error (UX-006)", () => {
  it("renders its own document, and nothing about the error", () => {
    const markup = renderToStaticMarkup(
      <GlobalError error={failure()} reset={vi.fn()} />,
    );

    expect(markup.startsWith("<html")).toBe(true);
    expect(markup).toContain("<body>");
    expect(markup).toContain("FactorSage could not load");
    expect(markup).not.toContain(SECRET);
    expect(markup).not.toContain("digest-456");
    expect(markup).not.toContain("layout.tsx");
  });

  it("logs to the console and retries through reset exactly once", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = failure();
    const reset = vi.fn();
    render(<GlobalError error={error} reset={reset} />);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(reset).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(error);
    expect(
      screen
        .getByRole("link", { name: "Go to the Dashboard" })
        .getAttribute("href"),
    ).toBe("/");
    expect(document.body.textContent).not.toContain(SECRET);
  });
});
