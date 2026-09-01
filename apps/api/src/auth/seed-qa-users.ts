import type { AuthUser } from "@intrinsic/contracts";
import { PrismaClient, UserRole } from "@intrinsic/database";
import { isValidEmail, normalizeEmail } from "./email";
import { PasswordService } from "./password.service";

export type QaPersonaInput = {
  /** Logical persona name used in documentation and Playwright projects. */
  readonly name: "QA_USER" | "QA_ADMIN";
  readonly email: string;
  readonly password: string;
  readonly role: UserRole;
};

export type SeededQaPersona = AuthUser & { readonly name: string };

/**
 * Creates or updates exactly the two persistent QA personas and nothing else.
 *
 * Rerunning is safe: each persona is upserted by its normalized email, its password hash is
 * refreshed from the environment, its role is re-asserted, and it is left email-verified so
 * browser tests can sign in through the normal UI. No other row is touched.
 */
export async function seedQaUsers(
  prisma: PrismaClient,
  passwords: PasswordService,
  personas: readonly QaPersonaInput[],
): Promise<SeededQaPersona[]> {
  const seeded: SeededQaPersona[] = [];

  for (const persona of personas) {
    const email = normalizeEmail(persona.email);
    if (!isValidEmail(email)) {
      throw new Error(
        `Invalid application configuration: ${persona.name}_EMAIL must be a valid email address`,
      );
    }

    const passwordHash = await passwords.hash(persona.password);
    const emailVerifiedAt = new Date();

    const user = await prisma.user.upsert({
      where: { email },
      update: { passwordHash, emailVerifiedAt, role: persona.role },
      create: { email, passwordHash, emailVerifiedAt, role: persona.role },
      select: { id: true, email: true, role: true },
    });

    // A persona is permanently verified, so any leftover token from earlier manual testing is
    // meaningless and is removed rather than left redeemable.
    await prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } });

    seeded.push({ ...user, name: persona.name });
  }

  return seeded;
}
