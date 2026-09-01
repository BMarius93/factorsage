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

export const PRODUCTION_QA_SEED_MESSAGE =
  "Refusing to seed QA personas: NODE_ENV is production. QA personas are development and test " +
  "infrastructure, and the QA_ADMIN persona is a real administrator account, so this command " +
  "must never run against a production database.";

/**
 * Hard stop for the QA persona seeder.
 *
 * Unlike `pnpm db:seed`, which exists to bootstrap a real administrator, this command creates
 * accounts whose credentials live in developer environment files. Whoever runs it may not realize
 * `DATABASE_URL` points at production, so the refusal is unconditional rather than a prompt.
 */
export function assertQaSeedingAllowed(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV?.trim() === "production") {
    throw new Error(PRODUCTION_QA_SEED_MESSAGE);
  }
}

/**
 * Creates or updates exactly the two persistent QA personas and nothing else.
 *
 * Refuses to run in production. Rerunning is otherwise safe: each persona is upserted by its
 * normalized email, its password hash is refreshed from the environment, its role is re-asserted,
 * and it is left email-verified so browser tests can sign in through the normal UI. No other row
 * is touched.
 */
export async function seedQaUsers(
  prisma: PrismaClient,
  passwords: PasswordService,
  personas: readonly QaPersonaInput[],
): Promise<SeededQaPersona[]> {
  // Guarded here as well as at the entry point, so no caller can reach the writes without it.
  assertQaSeedingAllowed();

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
