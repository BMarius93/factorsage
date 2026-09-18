import {
  ACCEPTED_RETURN_PATHS,
  NON_STRING_RETURN_PATHS,
  REJECTED_RETURN_PATHS,
  RETURN_PATH_DEFAULT,
  RETURN_PATH_MAX_LENGTH,
} from "@intrinsic/testing/return-path-corpus";
import { afterEach, describe, expect, it } from "vitest";
import { registerHref, signInHref } from "./guest-routes";
import {
  currentReturnPath,
  DEFAULT_RETURN_PATH,
  MAX_RETURN_PATH_LENGTH,
  safeReturnPath,
} from "./return-path";

describe("safeReturnPath (web)", () => {
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

  it("refuses what URLSearchParams hands back for an encoded external destination", () => {
    for (const query of [
      "next=%2F%2Fevil.example",
      "next=%2F%5Cevil.example",
      "next=https%3A%2F%2Fevil.example",
      "next=%2F%252F%252Fevil.example",
    ]) {
      const next = new URLSearchParams(query).get("next");
      expect(safeReturnPath(next), query).toBe(DEFAULT_RETURN_PATH);
    }
  });
});

describe("sign-in links carrying a return destination", () => {
  it("encodes the destination exactly once, so the sign-in page reads it back intact", () => {
    const destination = "/backtests/new?strategyId=s-1&stockListId=l-2";
    const href = signInHref(destination);

    expect(href).toBe(`/login?next=${encodeURIComponent(destination)}`);
    expect(
      new URLSearchParams(href.slice(href.indexOf("?") + 1)).get("next"),
    ).toBe(destination);
    expect(registerHref(destination)).toBe(
      `/register?next=${encodeURIComponent(destination)}`,
    );
  });

  it("leaves the default destination out of the link", () => {
    expect(signInHref()).toBe("/login");
    expect(signInHref("/dashboard")).toBe("/login");
    expect(registerHref()).toBe("/register");
  });

  it("never renders a link carrying a destination the sign-in page would refuse", () => {
    for (const [value] of REJECTED_RETURN_PATHS) {
      expect(signInHref(value)).toBe("/login");
      expect(registerHref(value)).toBe("/register");
    }
  });
});

describe("currentReturnPath", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("is the current path plus query, without the origin", () => {
    window.history.replaceState(
      null,
      "",
      "/backtests/new?strategyId=s-1&stockListId=l-2",
    );
    expect(currentReturnPath()).toBe(
      "/backtests/new?strategyId=s-1&stockListId=l-2",
    );
  });
});
