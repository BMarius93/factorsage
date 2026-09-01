import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { AUTH_CONFIG, type AuthConfig } from "../config/configuration.module";
import { PrismaService } from "../database/prisma.service";

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
   * Returns the owning user ID, or `null` when the token is unknown, expired, or already used.
   * Consuming and verifying must not be separable — a failure between them would burn a valid
   * link without verifying anyone — so both happen inside a single database transaction that
   * rolls the deletion back if the user update fails.
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
        await tx.emailVerificationToken.deleteMany({ where: { id: record.id } });
        return null;
      }

      // Single-use: concurrent redemptions serialize on this row, and only the transaction whose
      // delete actually removed it observes a count of one.
      const deleted = await tx.emailVerificationToken.deleteMany({
        where: { id: record.id },
      });
      if (deleted.count !== 1) {
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
