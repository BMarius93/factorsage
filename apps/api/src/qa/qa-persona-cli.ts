import { PrismaClient } from "@intrinsic/database";
import {
  MANUAL_QA_PERSONA_NAMES,
  resolveTestPersona,
  type ResolvedTestPersona,
} from "@intrinsic/testing";
import { PasswordService } from "../auth/password.service";
import { seedQaUsers, type QaPersonaInput } from "../auth/seed-qa-users";
import {
  redactDatabaseUrl,
  resolveQaPersonaEnvironment,
  type QaPersonaEnvironment,
} from "./qa-persona-environment";

/**
 * The parts `pnpm qa:seed` and `pnpm qa:reset` share: which personas, which database, and the
 * banner that tells the operator where they are about to act before anything happens.
 */

/** The manual QA personas with their credentials, or a failure naming the missing variable. */
export function manualQaPersonas(): readonly ResolvedTestPersona[] {
  return MANUAL_QA_PERSONA_NAMES.map((name) => resolveTestPersona(name));
}

export function toSeedInput(
  personas: readonly ResolvedTestPersona[],
): QaPersonaInput[] {
  return personas.map((persona) => ({
    name: persona.name,
    email: persona.email,
    password: persona.password,
    role: persona.role,
    plan: persona.plan,
  }));
}

/**
 * Prints the target before acting.
 *
 * The database name and host, never the credentials: the point is that an operator who is about to
 * delete content sees which database it is coming out of, in the same output as the deletion.
 */
export function announceTarget(
  command: string,
  environment: QaPersonaEnvironment,
): void {
  console.log(
    `${command}: ${environment.databaseName} on ${environment.host} ` +
      `(${environment.source} = ${redactDatabaseUrl(environment.databaseUrl)})`,
  );
}

export function qaPersonaPrismaClient(
  environment: QaPersonaEnvironment,
): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: environment.databaseUrl } },
  });
}

/**
 * Creates or updates exactly the manual QA personas and re-asserts each one's plan and role.
 *
 * Deliberately the *same* function the Playwright persona seeder calls
 * (`../auth/seed-qa-users.ts`): the plan a persona holds is written by one piece of code, in one
 * way, whichever database it is going into. Nothing here writes an entitlement — it writes
 * `User.plan`, which is what the central resolver reads for a real customer too, so a persona goes
 * through the ordinary entitlement path rather than a QA one.
 */
export async function seedManualQaPersonas(
  prisma: PrismaClient,
  personas: readonly ResolvedTestPersona[],
): Promise<void> {
  const seeded = await seedQaUsers(
    prisma,
    new PasswordService(),
    toSeedInput(personas),
  );
  for (const persona of seeded) {
    console.log(
      `  ${persona.name}: plan ${persona.plan}, role ${persona.role}`,
    );
  }
}

/** Resolves the environment, refusing a target that is not plainly a local QA one. */
export function qaPersonaEnvironment(): QaPersonaEnvironment {
  return resolveQaPersonaEnvironment();
}
