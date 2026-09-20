import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import NotFound from "./not-found";

describe("not-found (UX-006)", () => {
  it("is a styled, branded page with a way back to the Dashboard", () => {
    render(<NotFound />);

    const panel = screen.getByTestId("not-found");
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "This page does not exist",
      }),
    ).toBeDefined();
    expect(panel.getAttribute("role")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Go to the Dashboard" })
        .getAttribute("href"),
    ).toBe("/");
    expect(
      screen
        .getByRole("link", { name: "FactorSage home" })
        .getAttribute("href"),
    ).toBe("/");
  });
});
