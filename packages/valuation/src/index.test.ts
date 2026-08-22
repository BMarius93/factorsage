import { describe, expect, it } from "vitest";
import { VALUATION_PACKAGE_NAME } from "./index.js";

describe("valuation package", () => {
  it("loads without infrastructure dependencies", () => {
    expect(VALUATION_PACKAGE_NAME).toBe("@intrinsic/valuation");
  });
});
