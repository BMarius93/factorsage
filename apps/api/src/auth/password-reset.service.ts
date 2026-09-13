import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { AUTH_CONFIG, type AuthConfig } from "../config/configuration.module";
import { PrismaService } from "../database/prisma.service";

/** 256 bits of entropy; the plaintext exists only in the outbound email. */
const TOKEN_BYTES = 32;

export type IssuedPasswordResetToken = {
  /** Plaintext token. Never persisted and never logged. */
  readonly token: string;
  readonly expiresAt: Date;
};

export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Password-reset tokens.
 *
 * The same three rules as email verification, for the same reasons: only the SHA-256 hash is
 * stored, a user holds at most one outstanding token so issuing a new one invalidates the
 * previous link, and redemption happens inside the transaction that writes the new password —
 * a reset that consumed the token without changing the password, or changed the password
 * without consuming the token, would both be wrong.
 *
 * Reading a token is cheap and redeeming one is not, so the two are separate operations:
 * `hasRedeemableToken` filters out work nobody should be able to make the API do, and
 * `redeemToken` decides.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async issueToken(userId: string): Promise<IssuedPasswordResetToken> {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const tokenHash = hashPasswordResetToken(token);
    const expiresAt = new Date(
      Date.now() + this.config.passwordResetTtlSeconds * 1000,
    );

    await this.prisma.passwordResetToken.upsert({
      where: { userId },
      create: { userId, tokenHash, expiresAt },
      update: { tokenHash, expiresAt },
    });

    return { token, expiresAt };
  }

  /**
   * Whether a redeemable token exists for this plaintext **right now**.
   *
   * A SHA-256 and one lookup on the unique `tokenHash` index, so an unauthenticated caller
   * submitting invented tokens costs the API almost nothing. Without it, `/auth/reset-password`
   * would run a full Argon2id hash — deliberately expensive — for every arbitrary string anybody
   * posted at it, which is a CPU-exhaustion lever that does not need a guessed token to pull.
   *
   * **Advisory only.** The answer can be stale the instant it is read: the token may expire, be
   * rotated by a new request, or be consumed by a concurrent redemption while Argon2id is still
   * running. `redeemToken` re-reads and re-checks everything inside its transaction and remains
   * the single source of truth for whether a reset actually happens.
   *
   * A token found expired is cleared here, which is the one thing that can be decided outside the
   * transaction: an expired token can never become valid again.
   */
  async hasRedeemableToken(token: string): Promise<boolean> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashPasswordResetToken(token) },
      select: { id: true, expiresAt: true },
    });

    if (!record) {
      return false;
    }
    if (record.expiresAt.getTime() > Date.now()) {
      return true;
    }

    await this.prisma.passwordResetToken.deleteMany({ where: { id: record.id } });
    return false;
  }

  /**
   * Redeems a plaintext token: consumes it and installs the already-hashed password atomically.
   *
   * Returns the owning user ID, or `null` when the token is unknown, expired, or already used.
   * The caller hashes the password **before** calling, because Argon2id deliberately takes real
   * time and a transaction must not be held open across it. It is `hasRedeemableToken`, not the
   * hash, that keeps that ordering from being a free way to spend the API's CPU.
   *
   * Every check `hasRedeemableToken` made is made again here, against the same row, inside the
   * transaction. That repetition is the point: the cheap pass is a filter, this one is the
   * decision.
   *
   * Redeeming also marks the address verified and drops any pending verification token: holding
   * this link is proof of control of the inbox, which is exactly what verification asks for.
   * Without it, an account that never verified could reset its password and still not sign in.
   */
  redeemToken(input: {
    token: string;
    passwordHash: string;
  }): Promise<string | null> {
    const tokenHash = hashPasswordResetToken(input.token);

    return this.prisma.$transaction(async (tx) => {
      const record = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          expiresAt: true,
          user: { select: { emailVerifiedAt: true } },
        },
      });

      if (!record) {
        return null;
      }

      if (record.expiresAt.getTime() <= Date.now()) {
        await tx.passwordResetToken.deleteMany({ where: { id: record.id } });
        return null;
      }

      // Single-use: concurrent redemptions serialize on this row, and only the transaction whose
      // delete actually removed it observes a count of one.
      const deleted = await tx.passwordResetToken.deleteMany({
        where: { id: record.id },
      });
      if (deleted.count !== 1) {
        return null;
      }

      await tx.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: input.passwordHash,
          // Only for an address that was never verified. An account that already verified keeps
          // the instant it actually did so; a reset is not a second verification event.
          ...(record.user.emailVerifiedAt
            ? {}
            : { emailVerifiedAt: new Date() }),
        },
      });
      await tx.emailVerificationToken.deleteMany({
        where: { userId: record.userId },
      });

      return record.userId;
    });
  }
}
