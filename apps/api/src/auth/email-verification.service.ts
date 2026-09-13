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
 * Only the SHA-256 hash is stored, a user holds at most one outstanding token so issuing a new
 * one rotates and invalidates the previous one, and redemption deletes the row in the same
 * transaction that marks the user verified, so a token can never be replayed or wasted.
 *
 * `PasswordResetToken` is the same lifecycle and shares this one's concurrency rules; both are
 * stated once in `rotating-token.ts`.
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
   * Redeems a plaintext token: consumes it and marks its owner verified in one transaction.
   *
   * Returns the owning user ID, or `null` when the token is unknown, expired, already used, or
   * rotated away by a resend since it was read. Consuming and verifying must not be separable —
   * a failure between them would burn a valid link without verifying anyone — so both happen
   * inside a single database transaction that rolls the deletion back if the user update fails.
   *
   * The transaction is not what makes the consume safe; `rotating-token.ts` explains what does.
   */
  redeemToken(token: string): Promise<string | null> {
    const tokenHash = hashVerificationToken(token);

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
      // above: only the statement that actually removed *this* token proceeds to mark the
      // address verified. A concurrent redemption, or a resend that rotated this row to a new
      // link, both land here as a count of zero — and a resend is meant to invalidate the
      // previous link, so honouring it afterwards would defeat the rotation.
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
        data: { emailVerifiedAt: new Date() },
      });

      return record.userId;
    });
  }
}
