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
   * Redeems a plaintext token: consumes it and installs the already-hashed password atomically.
   *
   * Returns the owning user ID, or `null` when the token is unknown, expired, or already used.
   * The caller hashes the password **before** calling, because Argon2id deliberately takes real
   * time and a transaction must not be held open across it.
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
