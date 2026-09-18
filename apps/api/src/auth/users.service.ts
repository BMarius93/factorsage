import type { AuthUser } from "@intrinsic/contracts";
import { OAuthProvider, type User } from "@intrinsic/database";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { normalizeEmail } from "./email";

/**
 * A resolved sign-in: the safe user for the response, and the session version read from the same
 * row that authorised it, which the issued token must carry.
 */
export type SessionGrant = {
  readonly user: AuthUser;
  readonly sessionVersion: number;
};

type SafeUser = Pick<User, "id" | "email" | "role" | "plan">;
/**
 * A user as a session sees it: the safe projection plus the version its tokens must carry.
 * `sessionVersion` is authentication state, never a response field — `toAuthUser` drops it.
 */
type SessionUser = SafeUser & Pick<User, "sessionVersion">;
type PasswordLoginUser = SessionUser &
  Pick<User, "passwordHash" | "emailVerifiedAt">;
type IdentityUser = SessionUser &
  Pick<User, "passwordHash" | "emailVerifiedAt">;

/**
 * What a session may know about its own user.
 *
 * `role` and `plan` are both here because both are authorization inputs that must come from
 * persisted state: the cookie guard reloads this projection on every request, so the entitlement
 * resolver reads a plan and a role the server wrote, never ones a client asserted.
 */
const SAFE_USER_SELECT = {
  id: true,
  email: true,
  role: true,
  plan: true,
} as const;
/**
 * `SAFE_USER_SELECT` plus `sessionVersion`, for every read a session is issued or validated from.
 * Kept separate so the version is read on the same row, in the same query, as the identity it
 * authorises — a later second read could miss a concurrent revocation.
 */
const SESSION_USER_SELECT = {
  ...SAFE_USER_SELECT,
  sessionVersion: true,
} as const;
const IDENTITY_USER_SELECT = {
  ...SESSION_USER_SELECT,
  passwordHash: true,
  emailVerifiedAt: true,
} as const;

/**
 * Identity repository for the product `User` and its linked external accounts.
 *
 * Every read here is explicitly projected: `passwordHash` never leaves this service except on
 * the password-verification path, and it never appears in an API contract.
 */
@Injectable()
export class UsersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  findForPasswordLogin(email: string): Promise<PasswordLoginUser | null> {
    return this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: IDENTITY_USER_SELECT,
    });
  }

  findByEmail(email: string): Promise<IdentityUser | null> {
    return this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: IDENTITY_USER_SELECT,
    });
  }

  findAuthUserById(id: string): Promise<SessionUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: SESSION_USER_SELECT,
    });
  }

  /**
   * Revokes every session of the account by bumping its version, atomically in PostgreSQL — never
   * read, incremented and written back, so concurrent revocations only ever move it forward.
   * Returns whether the account still existed.
   */
  async incrementSessionVersion(userId: string): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
    });
    return count === 1;
  }

  /** Creates an unverified local-password user. Callers pass an already-hashed password. */
  createLocalUser(input: {
    email: string;
    passwordHash: string;
  }): Promise<SafeUser> {
    return this.prisma.user.create({
      data: {
        email: normalizeEmail(input.email),
        passwordHash: input.passwordHash,
      },
      select: SAFE_USER_SELECT,
    });
  }

  /** The product user behind an already-linked external identity, if any. */
  async findByOAuthAccount(
    provider: OAuthProvider,
    providerAccountId: string,
  ): Promise<IdentityUser | null> {
    const account = await this.prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: { provider, providerAccountId },
      },
      select: { user: { select: IDENTITY_USER_SELECT } },
    });

    return account?.user ?? null;
  }

  /**
   * Links an external identity to an existing account and marks the address verified.
   *
   * Callers must already have established that the provider is authoritative for the address —
   * `google-email-authority.ts` for Google. This service does not decide whether linking is safe.
   *
   * An account that was never verified loses its local password in the same transaction. Nobody
   * proved that password belongs to the mailbox owner: anyone can register an address they do not
   * control, and adopting that row as-is would let whoever chose the password sign in to the
   * owner's account. The result is a verified, external-only account. An already-verified account
   * keeps its password, because its owner proved control of both.
   */
  linkOAuthAccount(input: {
    userId: string;
    provider: OAuthProvider;
    providerAccountId: string;
  }): Promise<{ user: SessionUser; discardedUnverifiedPassword: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      // Decided here, not from the caller's earlier read: a verification redeemed in the meantime
      // makes the password the owner's. The conditional update is both the decision and the row
      // lock, so a redemption cannot land between it and the verification below.
      const { count } = await tx.user.updateMany({
        where: { id: input.userId, emailVerifiedAt: null },
        data: { passwordHash: null },
      });
      const discardedUnverifiedPassword = count === 1;
      if (discardedUnverifiedPassword) {
        // A reset link for a password that no longer exists would mint a new one for whoever
        // holds the link, so it goes with the credential.
        await tx.passwordResetToken.deleteMany({
          where: { userId: input.userId },
        });
      }

      await tx.oAuthAccount.create({
        data: {
          userId: input.userId,
          provider: input.provider,
          providerAccountId: input.providerAccountId,
        },
      });
      const user = await tx.user.update({
        where: { id: input.userId },
        data: { emailVerifiedAt: new Date() },
        select: SESSION_USER_SELECT,
      });
      // A pending local verification token is meaningless once the provider proved the address.
      await tx.emailVerificationToken.deleteMany({
        where: { userId: input.userId },
      });

      return { user, discardedUnverifiedPassword };
    });
  }

  /** Creates an external-identity-only, already-verified user with no local password. */
  createOAuthUser(input: {
    email: string;
    provider: OAuthProvider;
    providerAccountId: string;
  }): Promise<SessionUser> {
    return this.prisma.user.create({
      data: {
        email: normalizeEmail(input.email),
        emailVerifiedAt: new Date(),
        oauthAccounts: {
          create: {
            provider: input.provider,
            providerAccountId: input.providerAccountId,
          },
        },
      },
      select: SESSION_USER_SELECT,
    });
  }

  markEmailVerified(userId: string): Promise<SessionUser> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
      select: SESSION_USER_SELECT,
    });
  }

  /** What a successful sign-in hands to `AuthService.issueToken`. */
  toSessionGrant(user: SessionUser): SessionGrant {
    return {
      user: this.toAuthUser(user),
      sessionVersion: user.sessionVersion,
    };
  }

  toAuthUser(user: SafeUser): AuthUser {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      plan: user.plan,
    };
  }
}
