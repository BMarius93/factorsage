import { describe, expect, it } from "vitest";
import {
  mayLinkToExistingAccount,
  resolveGoogleEmailAuthority,
  type GoogleEmailAuthority,
} from "./google-email-authority";

function authority(
  email: string | null,
  options: { verified?: boolean; hostedDomain?: string | null } = {},
): GoogleEmailAuthority {
  return resolveGoogleEmailAuthority({
    email,
    emailVerified: options.verified ?? true,
    hostedDomain: options.hostedDomain ?? null,
  });
}

describe("resolveGoogleEmailAuthority", () => {
  it("treats the mailboxes Google operates as Google's own", () => {
    expect(authority("person@gmail.com")).toBe("GOOGLE_MAILBOX");
    // The historical German/UK alias of the same mail system.
    expect(authority("person@googlemail.com")).toBe("GOOGLE_MAILBOX");
  });

  it("ignores address casing and a trailing root dot on the domain", () => {
    expect(authority("Person@GMAIL.com")).toBe("GOOGLE_MAILBOX");
    expect(authority("person@gmail.com.")).toBe("GOOGLE_MAILBOX");
    expect(authority("a@Workspace.test", { hostedDomain: "WORKSPACE.test" })).toBe(
      "WORKSPACE_DOMAIN",
    );
  });

  it("accepts a Workspace domain only when hd names the address's own domain", () => {
    expect(authority("a@workspace.test", { hostedDomain: "workspace.test" })).toBe(
      "WORKSPACE_DOMAIN",
    );
    // Proving ownership of one domain proves nothing about another, including a subdomain
    // relationship in either direction.
    expect(authority("a@other.test", { hostedDomain: "workspace.test" })).toBe(
      "EXTERNAL",
    );
    expect(
      authority("a@evil-workspace.test", { hostedDomain: "workspace.test" }),
    ).toBe("EXTERNAL");
    expect(
      authority("a@mail.workspace.test", { hostedDomain: "workspace.test" }),
    ).toBe("EXTERNAL");
  });

  it("treats a verified address on a domain Google does not run as external", () => {
    // The whole point: Google will happily report this as verified for a consumer account that
    // was built around a third-party address.
    expect(authority("person@example.test")).toBe("EXTERNAL");
  });

  it("never reports more than external for a missing or unverified address", () => {
    expect(authority(null)).toBe("EXTERNAL");
    expect(authority("person@gmail.com", { verified: false })).toBe("EXTERNAL");
    expect(
      authority("a@workspace.test", {
        verified: false,
        hostedDomain: "workspace.test",
      }),
    ).toBe("EXTERNAL");
  });

  it("treats a malformed address as external rather than guessing a domain", () => {
    expect(authority("no-at-sign")).toBe("EXTERNAL");
    expect(authority("two@at@gmail.com")).toBe("EXTERNAL");
    expect(authority("person@")).toBe("EXTERNAL");
  });
});

describe("mayLinkToExistingAccount", () => {
  it("admits only the authorities Google actually speaks for", () => {
    expect(mayLinkToExistingAccount("GOOGLE_MAILBOX")).toBe(true);
    expect(mayLinkToExistingAccount("WORKSPACE_DOMAIN")).toBe(true);
    expect(mayLinkToExistingAccount("EXTERNAL")).toBe(false);
  });
});
