import { describe, expect, it } from "vitest";
import { normalizeStockSymbol } from "./route-symbol";

describe("normalizeStockSymbol", () => {
  it("uppercases and trims direct route input", () => {
    expect(normalizeStockSymbol("aapl")).toBe("AAPL");
    expect(normalizeStockSymbol("  msft ")).toBe("MSFT");
  });

  it("decodes URL-encoded symbols such as class shares", () => {
    expect(normalizeStockSymbol("brk.b")).toBe("BRK.B");
    expect(normalizeStockSymbol("BRK%2EB")).toBe("BRK.B");
    expect(normalizeStockSymbol("%20nvda%20")).toBe("NVDA");
  });

  it("passes malformed escapes through for the API to reject", () => {
    expect(normalizeStockSymbol("%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("reduces blank input to an empty symbol", () => {
    expect(normalizeStockSymbol("%20")).toBe("");
  });
});
