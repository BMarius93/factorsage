import { getQaPersonaConfig, loadRootEnv } from "@intrinsic/config";
import { PrismaClient, UserRole } from "@intrinsic/database";
import { PasswordService } from "./auth/password.service";
import { seedQaUsers, type QaPersonaInput } from "./auth/seed-qa-users";

/**
 * Seeds the persistent QA personas used by Playwright and live API smoke testing.
 *
 * Credentials come only from the environment, so no password ever appears in source control.
 */
async function seed(): Promise<void> {
  loadRootEnv();
  const config = getQaPersonaConfig();
  const personas: QaPersonaInput[] = [
    { name: "QA_USER", ...config.user, role: UserRole.USER },
    { name: "QA_ADMIN", ...config.admin, role: UserRole.ADMIN },
  ];
  const prisma = new PrismaClient();

  try {
    await prisma.$connect();
    const seeded = await seedQaUsers(prisma, new PasswordService(), personas);
    for (const persona of seeded) {
      console.log(`${persona.name} ready (role ${persona.role}).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`QA user seed failed: ${message}`);
  process.exitCode = 1;
});
