import { REQUIRED_TERMS_VERSION } from "@intrinsic/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { register, verifyEmail } from "./auth-api";

const apiPost = vi.fn();

vi.mock("../../../lib/api/client", () => ({
  API_BASE_URL: "http://api.example.test",
  ApiError: class ApiError extends Error {},
  apiGet: vi.fn(),
  apiPost: (...args: unknown[]) => apiPost(...args),
}));

describe("verifyEmail", () => {
  beforeEach(() => {
    apiPost.mockReset();
    apiPost.mockResolvedValue({ status: "verified" });
  });

  it("posts the token, the new password and the accepted Terms version in the body, never in the URL", async () => {
    const password = "Mailbox-owner-password-42";

    await expect(
      verifyEmail({
        token: "link-token",
        password,
        termsVersion: REQUIRED_TERMS_VERSION,
      }),
    ).resolves.toEqual({ status: "verified" });

    expect(apiPost).toHaveBeenCalledTimes(1);
    const [path, body] = apiPost.mock.calls[0] as [string, unknown];
    expect(path).toBe("/auth/verify-email");
    expect(path).not.toContain("?");
    expect(path).not.toContain(password);
    // The acceptance travels as a version, not a boolean: what was agreed to, rather than that
    // a box was ticked.
    expect(body).toEqual({
      token: "link-token",
      password,
      termsVersion: REQUIRED_TERMS_VERSION,
    });
  });
});

describe("register", () => {
  beforeEach(() => {
    apiPost.mockReset();
    apiPost.mockResolvedValue({ status: "accepted" });
  });

  it("sends the email address and nothing else (AUTH-003)", async () => {
    await expect(register({ email: "person@example.com" })).resolves.toEqual({
      status: "accepted",
    });

    expect(apiPost).toHaveBeenCalledTimes(1);
    const [path, body] = apiPost.mock.calls[0] as [string, unknown];
    expect(path).toBe("/auth/register");
    expect(body).toEqual({ email: "person@example.com" });
  });

  it("never forwards a password even if a caller passes one", async () => {
    const legacy = {
      email: "person@example.com",
      password: "Should-never-leave-the-page-42",
    } as unknown as Parameters<typeof register>[0];

    await register(legacy);

    const [, body] = apiPost.mock.calls[0] as [string, unknown];
    expect(body).toEqual({ email: "person@example.com" });
    expect(JSON.stringify(body)).not.toContain(
      "Should-never-leave-the-page-42",
    );
  });
});
