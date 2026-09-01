import type { AuthUser } from "@intrinsic/contracts";
import { OAuthProvider, type User } from "@intrinsic/database";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { normalizeEmail } from "./email";

type SafeUser = Pick<User, "id" | "email" | "role">;
type PasswordLoginUser = SafeUser &
  Pick<User, "passwordHash" | "emailVerifiedAt">;
type IdentityUser = SafeUser & Pick<User, "passwordHash" | "emailVerifiedAt">;

const SAFE_USER_SELECT = { id: true, email: true, role: true } as const;
const IDENTITY_USER_SELECT = {
  ...SAFE_USER_SELECT,
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

  findAuthUserById(id: string): Promise<SafeUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: SAFE_USER_SELECT,
    });
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
   * Callers must already have established that the provider reports this email as verified;
   * this service does not decide whether linking is safe.
   */
  async linkOAuthAccount(input: {
    userId: string;
    provider: OAuthProvider;
    providerAccountId: string;
  }): Promise<SafeUser> {
    const [, user] = await this.prisma.$transaction([
      this.prisma.oAuthAccount.create({
        data: {
          userId: input.userId,
          provider: input.provider,
          providerAccountId: input.providerAccountId,
        },
      }),
      this.prisma.user.update({
        where: { id: input.userId },
        data: { emailVerifiedAt: new Date() },
        select: SAFE_USER_SELECT,
      }),
      // A pending local verification token is meaningless once the provider proved the address.
      this.prisma.emailVerificationToken.deleteMany({
        where: { userId: input.userId },
      }),
    ]);

    return user;
  }

  /** Creates an external-identity-only, already-verified user with no local password. */
  createOAuthUser(input: {
    email: string;
    provider: OAuthProvider;
    providerAccountId: string;
  }): Promise<SafeUser> {
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
      select: SAFE_USER_SELECT,
    });
  }

  markEmailVerified(userId: string): Promise<SafeUser> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
      select: SAFE_USER_SELECT,
    });
  }

  toAuthUser(user: SafeUser): AuthUser {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
    };
  }
}
