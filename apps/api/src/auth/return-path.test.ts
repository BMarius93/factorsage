import {
  ACCEPTED_RETURN_PATHS,
  NON_STRING_RETURN_PATHS,
  REJECTED_RETURN_PATHS,
  RETURN_PATH_DEFAULT,
  RETURN_PATH_MAX_LENGTH,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETURN_PATH,
  MAX_RETURN_PATH_LENGTH,
  safeReturnPath,
} from "./return-path";

describe("safeReturnPath (API)", () => {
  it("agrees with the shared corpus on the default and the bound", () => {
    expect(DEFAULT_RETURN_PATH).toBe(RETURN_PATH_DEFAULT);
    expect(MAX_RETURN_PATH_LENGTH).toBe(RETURN_PATH_MAX_LENGTH);
  });

  it.each(ACCEPTED_RETURN_PATHS.map((value) => [value]))(
    "accepts %j unchanged",
    (value) => {
      expect(safeReturnPath(value)).toBe(value);
    },
  );

  it.each(REJECTED_RETURN_PATHS.map(([value, reason]) => [reason, value]))(
    "refuses %s",
    (_reason, value) => {
      expect(safeReturnPath(value)).toBe(DEFAULT_RETURN_PATH);
    },
  );

  it.each(NON_STRING_RETURN_PATHS.map((value) => [value]))(
    "refuses the non-string %j",
    (value) => {
      expect(safeReturnPath(value)).toBe(DEFAULT_RETURN_PATH);
    },
  );

  it("never yields anything that leaves the web origin once appended to it", () => {
    const web = "https://app.factorsage.test";
    for (const value of [
      ...ACCEPTED_RETURN_PATHS,
      ...REJECTED_RETURN_PATHS.map(([rejected]) => rejected),
    ]) {
      const location = new URL(`${web}${safeReturnPath(value)}`);
      expect(location.origin, JSON.stringify(value)).toBe(web);
    }
  });
});
