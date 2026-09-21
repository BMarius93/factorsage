import { REQUIRED_TERMS_VERSION, type AuthUser } from "@intrinsic/contracts";
import { OAuthProvider, type Prisma, type User } from "@intrinsic/database";
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
 * A user as a session sees it: the safe projection, the version its tokens must carry, and
 * whether the account has accepted the required Terms version.
 *
 * `sessionVersion` is authentication state and `legalRecords` is compliance state; neither is a
 * response field, and `toAuthUser` drops both.
 */
type SessionUser = SafeUser &
  Pick<User, "sessionVersion"> & {
    /** At most one row: the required Terms acceptance, or nothing. See `TERMS_ACCEPTANCE_SELECT`. */
    readonly legalRecords: readonly { readonly id: string }[];
  };
type PasswordLoginUser = SessionUser &
  Pick<User, "passwordHash" | "emailVerifiedAt">;
type IdentityUser = SessionUser &
  Pick<User, "passwordHash" | "emailVerifiedAt">;

/**
 * What an unauthenticated activation request (register, resend) may know about an address's
 * account: whether it is verified, and when it last claimed a registration email (AUTH-003).
 * Deliberately no credential: registration never reads or writes a verified account's password.
 */
export type ActivationCandidate = Pick<
  User,
  "id" | "emailVerifiedAt" | "registrationEmailClaimedAt"
>;

/** Which ways an existing account signs in, for the wording of the existing-account notice. */
export type SignInMethods = {
  readonly password: boolean;
  readonly google: boolean;
};

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
/**
 * The one acceptance question a session asks: has this account accepted **the required** Terms
 * version?
 *
 * It rides on the session read rather than being a second query, which matters twice over. It
 * costs the acceptance gate nothing per request, and — more importantly — the acceptance state is
 * read on the same row, in the same statement, as the identity it is about, so an acceptance
 * committed between two reads can never be missed by one and seen by the other.
 *
 * `take: 1` because the unique index means there is at most one such row anyway; the point is to
 * fetch a presence, not a record.
 */
const TERMS_ACCEPTANCE_SELECT = {
  where: {
    documentKind: "TERMS",
    documentVersion: REQUIRED_TERMS_VERSION,
    record: "ACCEPTED",
  },
  select: { id: true },
  take: 1,
} as const;

const SESSION_USER_SELECT = {
  ...SAFE_USER_SELECT,
  sessionVersion: true,
  legalRecords: TERMS_ACCEPTANCE_SELECT,
} as const;
const ACTIVATION_CANDIDATE_SELECT = {
  id: true,
  emailVerifiedAt: true,
  registrationEmailClaimedAt: true,
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

  findActivationCandidate(email: string): Promise<ActivationCandidate | null> {
    return this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: ACTIVATION_CANDIDATE_SELECT,
    });
  }

  /**
   * Creates a pending account for an address nobody holds yet: unverified, **no password**, and
   * already holding the registration-email claim its creator is about to use (AUTH-003).
   *
   * Returns `null` when a concurrent request created the address first — the unique index on
   * `email` decides, and the caller re-reads the winner's row rather than failing the request.
   */
  async createPendingUser(input: {
    email: string;
    claimedAt: Date;
  }): Promise<ActivationCandidate | null> {
    try {
      return await this.prisma.user.create({
        data: {
          email: normalizeEmail(input.email),
          registrationEmailClaimedAt: input.claimedAt,
        },
        select: ACTIVATION_CANDIDATE_SELECT,
      });
    } catch (error) {
      if (
        (error as Prisma.PrismaClientKnownRequestError | undefined)?.code ===
        "P2002"
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Takes the registration-email claim for an account, or reports that somebody else holds it.
   *
   * One conditional `UPDATE`, so it is the concurrency gate: it matches only while the column still
   * holds the value the caller read (`previous`), and only while the account is still in the state
   * the caller decided on. Of any number of concurrent requests for one address exactly one sees a
   * count of one; the others — and a request racing a verification, a reset or a Google link that
   * verified the account first — see zero and send nothing. The cooldown itself is decided by the
   * caller against `previous`; this statement makes that decision atomic.
   *
   * Claiming for a **pending** account also clears an inert password left by registration before
   * AUTH-003. Nobody proved that password; verification replaces it anyway, and clearing it here
   * means an old row stops carrying a credential the moment its owner asks for a new link. The
   * `emailVerifiedAt: null` predicate is re-evaluated on the locked row, so a verification that
   * commits first keeps the owner's password.
   */
  async claimRegistrationEmail(input: {
    userId: string;
    previous: Date | null;
    claimedAt: Date;
    accountState: "pending" | "verified";
  }): Promise<boolean> {
    const pending = input.accountState === "pending";
    const { count } = await this.prisma.user.updateMany({
      where: {
        id: input.userId,
        registrationEmailClaimedAt: input.previous,
        emailVerifiedAt: pending ? null : { not: null },
      },
      data: pending
        ? { registrationEmailClaimedAt: input.claimedAt, passwordHash: null }
        : { registrationEmailClaimedAt: input.claimedAt },
    });
    return count === 1;
  }

  /**
   * Gives a claim back after its email could not be sent, so the owner can retry at once instead
   * of waiting out a cooldown for a message that never left. Conditional on still holding exactly
   * this claim; a newer one is never overwritten.
   */
  async releaseRegistrationEmail(input: {
    userId: string;
    claimedAt: Date;
    previous: Date | null;
  }): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: input.userId, registrationEmailClaimedAt: input.claimedAt },
      data: { registrationEmailClaimedAt: input.previous },
    });
  }

  /** Whether the account still exists and is unverified, read now rather than trusted from earlier. */
  async isPendingActivation(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerifiedAt: true },
    });
    return user !== null && user.emailVerifiedAt === null;
  }

  /** Address and sign-in methods, read only by the out-of-band email task. */
  async findEmailRecipient(
    userId: string,
  ): Promise<{ email: string; methods: SignInMethods } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        passwordHash: true,
        oauthAccounts: {
          where: { provider: OAuthProvider.GOOGLE },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!user) {
      return null;
    }
    return {
      email: user.email,
      methods: {
        password: user.passwordHash !== null,
        google: user.oauthAccounts.length > 0,
      },
    };
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

  /**
   * Whether this session's account has accepted the Terms version the product requires.
   *
   * Derived from the projection above rather than asked separately, so the answer belongs to the
   * same read as the identity. `LegalAcceptanceInterceptor` is its only consumer.
   */
  hasAcceptedRequiredTerms(user: SessionUser): boolean {
    return user.legalRecords.length > 0;
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
