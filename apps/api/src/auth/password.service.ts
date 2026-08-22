import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import * as argon2 from "argon2";

@Injectable()
export class PasswordService {
  private readonly dummyPasswordHash = this.hash(
    randomBytes(32).toString("base64"),
  );

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(
    passwordHash: string | null | undefined,
    password: string,
  ): Promise<boolean> {
    const dummyPasswordHash = await this.dummyPasswordHash;

    try {
      const verified = await argon2.verify(
        passwordHash ?? dummyPasswordHash,
        password,
      );
      return passwordHash != null && verified;
    } catch {
      return false;
    }
  }
}
