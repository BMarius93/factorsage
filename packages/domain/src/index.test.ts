import { describe, expect, it } from "vitest";
import { DOMAIN_PACKAGE_NAME } from "./index.js";

describe("domain package", () => {
  it("loads without infrastructure dependencies", () => {
    expect(DOMAIN_PACKAGE_NAME).toBe("@intrinsic/domain");
  });
});
