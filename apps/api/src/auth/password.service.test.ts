import { beforeAll, describe, expect, it } from "vitest";
import { PasswordService } from "./password.service";

describe("PasswordService", () => {
  const password = "correct horse battery staple";
  const passwords = new PasswordService();
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await passwords.hash(password);
  });

  it("generates an Argon2id hash instead of storing plaintext", () => {
    expect(passwordHash).not.toBe(password);
    expect(passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("verifies the valid password", async () => {
    await expect(passwords.verify(passwordHash, password)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    await expect(
      passwords.verify(passwordHash, "incorrect password"),
    ).resolves.toBe(false);
  });

  it("performs safe verification and rejects a missing hash", async () => {
    await expect(passwords.verify(null, password)).resolves.toBe(false);
  });
});
