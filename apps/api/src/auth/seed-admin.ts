import type { AuthUser } from "@intrinsic/contracts";
import { PrismaClient, UserRole } from "@intrinsic/database";
import { isValidEmail, normalizeEmail } from "./email";
import { PasswordService } from "./password.service";

type SeedAdminInput = {
  email: string;
  password: string;
};

export async function seedInitialAdmin(
  prisma: PrismaClient,
  passwords: PasswordService,
  input: SeedAdminInput,
): Promise<AuthUser> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    throw new Error(
      "Invalid application configuration: ADMIN_EMAIL must be a valid email address",
    );
  }

  const passwordHash = await passwords.hash(input.password);
  return prisma.user.upsert({
    where: { email },
    update: {
      passwordHash,
      role: UserRole.ADMIN,
    },
    create: {
      email,
      passwordHash,
      role: UserRole.ADMIN,
    },
    select: {
      id: true,
      email: true,
      role: true,
    },
  });
}
