// Audit-only: creates four additional verified accounts in TEST_DATABASE_URL (never the dev DB)
// for the UI/UX audit personas. Reuses the product's own QA seeder, so the rows are exactly what
// `pnpm test:users:seed` would write for a persona. Content is then created through the public API
// by populate.mjs, never by writing domain rows directly.
//
// Run: pnpm --filter @intrinsic/api exec tsx ../../artifacts/ui-audit/harness/seed-audit-users.ts
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { PasswordService } from "../../../apps/api/src/auth/password.service";
import { seedQaUsers } from "../../../apps/api/src/auth/seed-qa-users";
import { qaSeedDatabaseUrl } from "../../../apps/api/src/stocks/seed-qa-securities";

const apiRequire = createRequire(join(resolve(__dirname, "../../../apps/api"), "package.json"));
const { loadRootEnv } = apiRequire("@intrinsic/config");
const { PrismaClient } = apiRequire("@intrinsic/database");

const PASSWORD = process.env.UI_AUDIT_PASSWORD ?? "";
if (PASSWORD.length < 12) throw new Error("Set UI_AUDIT_PASSWORD (12+ characters) before seeding audit personas.");
const PERSONAS = [
  { name: "AUDIT_FREE_EMPTY", email: "audit-free-empty@factorsage.test", plan: "FREE" },
  { name: "AUDIT_FREE_NORMAL", email: "audit-free-normal@factorsage.test", plan: "FREE" },
  { name: "AUDIT_STARTER", email: "audit-starter@factorsage.test", plan: "STARTER" },
  { name: "AUDIT_PRO_HEAVY", email: "audit-pro-heavy@factorsage.test", plan: "PRO" },
] as const;

async function main() {
  loadRootEnv();
  const url = qaSeedDatabaseUrl();
  if (!/intrinsic_value_test/.test(url)) throw new Error("refusing: not the test database");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const seeded = await seedQaUsers(
      prisma,
      new PasswordService(),
      PERSONAS.map((p) => ({ ...p, password: PASSWORD, role: "USER" as const })),
    );
    for (const s of seeded) console.log(`${s.name} ready (${s.plan}).`);
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
