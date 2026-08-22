import { getAdminBootstrapConfig, loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { PasswordService } from "./auth/password.service";
import { seedInitialAdmin } from "./auth/seed-admin";

async function seed(): Promise<void> {
  loadRootEnv();
  const config = getAdminBootstrapConfig();
  const prisma = new PrismaClient();

  try {
    await prisma.$connect();
    await seedInitialAdmin(prisma, new PasswordService(), config);
    console.log("Bootstrap admin is ready.");
  } finally {
    await prisma.$disconnect();
  }
}

void seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Admin seed failed: ${message}`);
  process.exitCode = 1;
});