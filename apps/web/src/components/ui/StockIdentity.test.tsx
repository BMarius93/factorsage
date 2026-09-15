import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** jsdom cannot rasterise, so a sampled logo needs its pixels supplied. */
function stubSampledPixels(r: number, g: number, b: number): void {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = 255;
  }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data }) as ImageData),
  } as unknown as CanvasRenderingContext2D);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StockLogo", () => {
  it("loads every mark from the product's own cached endpoint", () => {
    const { container } = render(
      <StockLogo symbol="AAPL" name="Apple Inc." logoUrl="https://provider/aapl.png" />,
    );
    const image = container.querySelector("img");
    // Never the provider URL: one same-origin, ticker-keyed cache entry is what keeps the mark
    // from visibly reloading on every surface, and what keeps the brightness sample legal.
    expect(image?.getAttribute("src")).toBe("/api/logo/AAPL");
    // Decorative: the symbol and name sit beside it, so announcing it would read twice.
    expect(image?.getAttribute("alt")).toBe("");
  });

  it("renders a mark for a security the catalog has not profiled", () => {
    // The endpoint is keyed by ticker, so a list member nobody has opened is not condemned to
    // initials just because no `SecurityProfile` row exists yet.
    const { container } = render(<StockLogo symbol="MSFT" name="Microsoft" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/logo/MSFT",
    );
  });

  it("falls back to the monogram when the image fails to load", () => {
    const { container } = render(
      <StockLogo symbol="AAPL" name="Apple Inc." logoUrl="https://provider/gone.png" />,
    );

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector("[data-monogram]")?.getAttribute("data-monogram"),
    ).toBe("AA");
  });

  it("renders the monogram with no request when the ticker cannot be routed", () => {
    const { container } = render(<StockLogo symbol="BRK B" name="Berkshire" />);
    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector("[data-monogram]")?.getAttribute("data-monogram"),
    ).toBe("BR");
  });

  it("puts a dark plate behind a near-white mark", () => {
    stubSampledPixels(255, 255, 255);
    const { container } = render(<StockLogo symbol="AAPL" name="Apple Inc." />);

    fireEvent.load(container.querySelector("img")!);

    expect(
      container.querySelector("[data-size]")?.getAttribute("data-bright"),
    ).toBe("true");
  });

  it("leaves an ordinary mark on the ordinary surface", () => {
    stubSampledPixels(20, 24, 31);
    const { container } = render(<StockLogo symbol="AAPL" name="Apple Inc." />);

    fireEvent.load(container.querySelector("img")!);

    expect(
      container.querySelector("[data-size]")?.getAttribute("data-bright"),
    ).toBeNull();
  });

  it("drops the previous security's plate and failure when the row is recycled", () => {
    stubSampledPixels(255, 255, 255);
    const { container, rerender } = render(<StockLogo symbol="AAPL" />);
    fireEvent.load(container.querySelector("img")!);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();

    rerender(<StockLogo symbol="MSFT" />);

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/logo/MSFT",
    );
    expect(
      container.querySelector("[data-size]")?.getAttribute("data-bright"),
    ).toBeNull();
  });

  it("plates a bright mark that was already in cache when it mounted", () => {
    stubSampledPixels(255, 255, 255);
    // What repeat navigation looks like: the image is decoded before React can attach `onLoad`,
    // so no load event is ever delivered. Without the mount-time check the plate would appear on
    // a cold visit and disappear on every visit after it — the case the HTTP cache makes normal.
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true,
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      100,
    );

    const { container } = render(<StockLogo symbol="AAPL" />);

    expect(
      container.querySelector("[data-size]")?.getAttribute("data-bright"),
    ).toBe("true");
  });

  it("reserves its box before anything loads, so a row cannot jump", () => {
    const { container } = render(<StockLogo symbol="AAPL" size="md" />);
    const box = container.querySelector("[data-size]");
    // The size lives on the container, never on the image: the box is laid out before the
    // request is even issued, and it is the same box the monogram fallback occupies.
    expect(box?.getAttribute("data-size")).toBe("md");
    const image = container.querySelector("img");
    expect(image?.getAttribute("width")).toBeNull();
    expect(image?.getAttribute("height")).toBeNull();
  });

  it("defers a collection's marks and not the page's own", () => {
    const { container: row } = render(<StockLogo symbol="AAPL" />);
    expect(row.querySelector("img")?.getAttribute("loading")).toBe("lazy");

    const { container: header } = render(
      <StockLogo symbol="AAPL" size="lg" loading="eager" />,
    );
    expect(header.querySelector("img")?.getAttribute("loading")).toBe("eager");
  });

  it("keeps the monogram out of the text layer", () => {
    const { container } = render(<StockLogo symbol="BRK B" name="Berkshire" />);
    // The initials are CSS generated content, so a row's text is the symbol and the
    // company name — never "BRBRK B".
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

  it("renders a real mark when the contract projects one", () => {
    const { container } = render(
      <StockIdentity
        symbol="AAPL"
        name="Apple Inc."
        logoUrl="https://images.financialmodelingprep.com/symbol/AAPL.png"
      />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/logo/AAPL",
    );
  });

  it("falls back to the monogram when the mark fails", () => {
    const { container } = render(
      <StockIdentity symbol="AAPL" name="Apple Inc." logoUrl="https://gone/aapl.png" />,
    );

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector("[data-monogram]")?.getAttribute("data-monogram"),
    ).toBe("AA");
    // The row still reads exactly the same: the fallback is decoration swapping for decoration.
    expect(screen.getByText("AAPL")).toBeDefined();
    expect(screen.getByText("Apple Inc.")).toBeDefined();
  });

  it("can show something other than the company name as the second line", () => {
    render(<StockIdentity symbol="AAPL" name="Apple Inc." secondary="12 Mar 2026" />);
    expect(screen.getByText("12 Mar 2026")).toBeDefined();
    expect(screen.queryByText("Apple Inc.")).toBeNull();
  });
});
