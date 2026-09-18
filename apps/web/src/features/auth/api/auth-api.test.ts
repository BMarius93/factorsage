import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyEmail } from "./auth-api";

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

  it("posts the token and the new password in the body, never in the URL", async () => {
    const password = "Mailbox-owner-password-42";

    await expect(
      verifyEmail({ token: "link-token", password }),
    ).resolves.toEqual({ status: "verified" });

    expect(apiPost).toHaveBeenCalledTimes(1);
    const [path, body] = apiPost.mock.calls[0] as [string, unknown];
    expect(path).toBe("/auth/verify-email");
    expect(path).not.toContain("?");
    expect(path).not.toContain(password);
    expect(body).toEqual({ token: "link-token", password });
  });
});
