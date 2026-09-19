import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetailSkeleton } from "./Skeleton";

describe("DetailSkeleton (UI-027)", () => {
  it("keeps the page's header frame, back link and one loading heading", () => {
    render(
      <DetailSkeleton thing="list" back={{ href: "/lists", label: "Lists" }} />,
    );

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe("Loading list…");
    expect(
      screen.getByRole("link", { name: /Lists/ }).getAttribute("href"),
    ).toBe("/lists");
    expect(
      screen.getByTestId("detail-skeleton").getAttribute("aria-busy"),
    ).toBe("true");
  });
});
