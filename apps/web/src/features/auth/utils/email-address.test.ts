import { describe, expect, it } from "vitest";
import { MAX_EMAIL_ADDRESS_LENGTH, isValidEmailAddress } from "./email-address";

/**
 * The same cases the API's rule (`apps/api/src/auth/email.ts`) decides: what the browser refuses
 * must be a subset of what the server refuses, never more.
 */
describe("isValidEmailAddress", () => {
  it.each([
    "person@example.com",
    "Person.Name+tag@Example.co.uk",
    "  person@example.com  ",
    "a@b.c",
  ])("accepts %s", (value) => {
    expect(isValidEmailAddress(value)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["no @", "person.example.com"],
    ["no domain dot", "person@example"],
    ["two @", "person@@example.com"],
    ["inner whitespace", "per son@example.com"],
    ["nothing before @", "@example.com"],
  ])("refuses %s", (_label, value) => {
    expect(isValidEmailAddress(value)).toBe(false);
  });

  it("refuses an address longer than the API accepts, and only then", () => {
    const domain = "@example.com";
    const longest = `${"a".repeat(MAX_EMAIL_ADDRESS_LENGTH - domain.length)}${domain}`;
    expect(isValidEmailAddress(longest)).toBe(true);
    expect(isValidEmailAddress(`a${longest}`)).toBe(false);
  });
});
