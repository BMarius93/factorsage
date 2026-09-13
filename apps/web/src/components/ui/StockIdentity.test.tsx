import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { logoMonogram, StockIdentity, StockLogo } from "./StockIdentity";

describe("logoMonogram", () => {
  it("prefers the ticker", () => {
    expect(logoMonogram("AAPL", "Apple Inc.")).toBe("AA");
  });

  it("falls back to the company name when the ticker is too short", () => {
    expect(logoMonogram("", "Apple Incorporated")).toBe("AI");
    expect(logoMonogram("", "Apple")).toBe("AP");
  });

  it("never renders nothing", () => {
    expect(logoMonogram("", "")).toBe("?");
  });
});

describe("StockLogo", () => {
  it("renders the company image when one is available", () => {
    const { container } = render(
      <StockLogo symbol="AAPL" name="Apple Inc." logoUrl="https://cdn/aapl.png" />,
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://cdn/aapl.png");
    // Decorative: the symbol and name sit beside it, so announcing it would read twice.
    expect(image?.getAttribute("alt")).toBe("");
  });

  it("falls back to the monogram when the image fails to load", () => {
    const { container } = render(
      <StockLogo symbol="AAPL" name="Apple Inc." logoUrl="https://cdn/gone.png" />,
    );

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector("[data-monogram]")?.getAttribute("data-monogram"),
    ).toBe("AA");
  });

  it("keeps the monogram out of the text layer", () => {
    const { container } = render(<StockLogo symbol="AAPL" name="Apple Inc." />);
    // The initials are CSS generated content, so a row's text is the symbol and the
    // company name — never "AAAAPL".
    expect(container.textContent).toBe("");
  });
});

describe("StockIdentity", () => {
  it("links to the stock when a destination is given", () => {
    render(<StockIdentity symbol="AAPL" name="Apple Inc." href="/stocks/AAPL" />);

    const link = screen.getByRole("link", { name: /AAPL/ });
    expect(link.getAttribute("href")).toBe("/stocks/AAPL");
    expect(screen.getByText("Apple Inc.")).toBeDefined();
  });

  it("renders as plain identity when there is nowhere to go", () => {
    render(<StockIdentity symbol="AAPL" name="Apple Inc." />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("AAPL")).toBeDefined();
  });

  it("can show something other than the company name as the second line", () => {
    render(<StockIdentity symbol="AAPL" name="Apple Inc." secondary="12 Mar 2026" />);
    expect(screen.getByText("12 Mar 2026")).toBeDefined();
    expect(screen.queryByText("Apple Inc.")).toBeNull();
  });
});
