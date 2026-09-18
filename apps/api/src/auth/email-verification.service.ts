import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { AUTH_CONFIG, type AuthConfig } from "../config/configuration.module";
import { PrismaService } from "../database/prisma.service";
import {
  consumeRotatingToken,
  discardExpiredRotatingToken,
} from "./rotating-token";

/** 256 bits of entropy; the plaintext exists only in the outbound email. */
const TOKEN_BYTES = 32;

export type IssuedVerificationToken = {
  /** Plaintext token. Never persisted and never logged. */
  readonly token: string;
  readonly expiresAt: Date;
};

export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Email-verification tokens.
 *
 * Only the SHA-256 hash is stored, and a user holds at most one outstanding token so issuing a new
 * one rotates and invalidates the previous one.
 *
 * Redeeming a token is also how the account's password is set (AUTH-002). Whoever registered the
 * address proved nothing about the mailbox, so a password chosen at registration is never what
 * verification activates: the person holding the link chooses the password, and consuming the
 * token, installing that password, verifying the address and revoking every earlier session all
 * happen in one transaction.
 *
 * `PasswordResetToken` is the same lifecycle and shares this one's concurrency rules; both are
 * stated once in `rotating-token.ts`. Redemption follows the reset's cheap-first shape for the
 * same reason: it now pays for an Argon2id hash.
 */
@Injectable()
export class EmailVerificationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async issueToken(userId: string): Promise<IssuedVerificationToken> {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const tokenHash = hashVerificationToken(token);
    const expiresAt = new Date(
      Date.now() + this.config.emailVerificationTtlSeconds * 1000,
    );

    await this.prisma.emailVerificationToken.upsert({
      where: { userId },
      create: { userId, tokenHash, expiresAt },
      update: { tokenHash, expiresAt },
    });

    return { token, expiresAt };
  }

  /**
   * Whether a redeemable token exists for this plaintext **right now**.
   *
   * A SHA-256 and one indexed lookup, so invented tokens cannot make the unauthenticated
   * endpoint spend a full Argon2id hash each. **Advisory only** — `redeemToken` re-checks
   * everything inside its transaction and is the single source of truth. A token found expired is
   * cleared here, conditionally on still being the row that was read (`rotating-token.ts`).
   */
  async hasRedeemableToken(token: string): Promise<boolean> {
    const tokenHash = hashVerificationToken(token);
    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash },
      select: { id: true, expiresAt: true },
    });

    if (!record) {
      return false;
    }
    if (record.expiresAt.getTime() > Date.now()) {
      return true;
    }

    await discardExpiredRotatingToken(this.prisma.emailVerificationToken, {
      id: record.id,
      tokenHash,
    });
    return false;
  }

  /**
   * Redeems a plaintext token: consumes it, installs the already-hashed password chosen by the
   * holder of the link, marks the address verified and revokes every existing session — all in
   * one transaction, so either every effect commits or none does.
   *
   * Returns the owning user ID, or `null` when the token is unknown, expired, already used, or
   * rotated away by a resend since it was read. The caller hashes the password **before** calling,
   * because Argon2id deliberately takes real time and a transaction must not be held open across
   * it; `hasRedeemableToken` is what keeps that ordering from being a free way to spend CPU.
   *
   * Nothing about the account is trusted from a read taken outside this transaction.
   */
  redeemToken(input: {
    token: string;
    passwordHash: string;
  }): Promise<string | null> {
    const tokenHash = hashVerificationToken(input.token);

    return this.prisma.$transaction(async (tx) => {
      const record = await tx.emailVerificationToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, expiresAt: true },
      });

      if (!record) {
        return null;
      }

      if (record.expiresAt.getTime() <= Date.now()) {
        await discardExpiredRotatingToken(tx.emailVerificationToken, {
          id: record.id,
          tokenHash,
        });
        return null;
      }

      // Single-use, and the gate for every other way this row can change underneath the read
      // above: only the statement that actually removed *this* token proceeds to set a password.
      // A concurrent redemption, or a resend that rotated this row to a new link, both land here
      // as a count of zero — so two redemptions of one link can never both install a password.
      if (
        !(await consumeRotatingToken(tx.emailVerificationToken, {
          id: record.id,
          tokenHash,
        }))
      ) {
        return null;
      }

      await tx.user.update({
        where: { id: record.userId },
        data: {
          // Replaces whatever registration stored. That password was chosen before anyone proved
          // control of the mailbox, so it must never become a working credential (AUTH-002).
          passwordHash: input.passwordHash,
          // A password was just installed, so every session issued before it ends, exactly as a
          // reset does. A never-verified account has none; an account that verified while a
          // resent link was still outstanding may. Atomic, never read-modify-written.
          sessionVersion: { increment: 1 },
        },
      });
      // Decided on the row the update above just locked, not on any earlier read. An account
      // that is already verified keeps the instant it actually verified.
      await tx.user.updateMany({
        where: { id: record.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      });
      // A reset link issued before this moment was issued against the credential being
      // replaced, so it goes with it; changing the password from here takes a fresh request.
      await tx.passwordResetToken.deleteMany({
        where: { userId: record.userId },
      });

      return record.userId;
    });
  }
}
