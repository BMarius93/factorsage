import { describe, expect, it } from "vitest";
import { isCurrentSession, parseSessionClaims } from "./session-token";

describe("parseSessionClaims", () => {
  it("reads the subject and an explicit version, including 0", () => {
    expect(parseSessionClaims({ sub: "user-1", sv: 0 })).toEqual({
      subject: "user-1",
      sessionVersion: 0,
    });
    expect(parseSessionClaims({ sub: "user-1", sv: 7, iat: 1 })).toEqual({
      subject: "user-1",
      sessionVersion: 7,
    });
  });

  it("marks a token that predates the claim as legacy", () => {
    expect(parseSessionClaims({ sub: "user-1", iat: 1 })).toEqual({
      subject: "user-1",
      sessionVersion: null,
    });
  });

  it("refuses a version that is present but not a non-negative safe integer", () => {
    for (const sv of [-1, 0.5, "1", null, undefined, true, NaN, 2 ** 53, [0]]) {
      expect(parseSessionClaims({ sub: "user-1", sv })).toBeNull();
    }
  });

  it("refuses a payload without a usable subject", () => {
    for (const payload of [
      null,
      "user-1",
      {},
      { sub: "" },
      { sub: 1, sv: 0 },
    ]) {
      expect(parseSessionClaims(payload)).toBeNull();
    }
  });
});

describe("isCurrentSession", () => {
  it("requires the claim to equal the stored version exactly", () => {
    expect(isCurrentSession(3, 3)).toBe(true);
    expect(isCurrentSession(2, 3)).toBe(false);
    expect(isCurrentSession(4, 3)).toBe(false);
  });

  it("accepts a legacy token only while the account is at version 0", () => {
    expect(isCurrentSession(null, 0)).toBe(true);
    expect(isCurrentSession(null, 1)).toBe(false);
  });
});
