import type { AuthUser } from "@intrinsic/contracts";
import type { User } from "@intrinsic/database";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { normalizeEmail } from "./email";

type SafeUser = Pick<User, "id" | "email" | "role">;
type PasswordLoginUser = SafeUser & Pick<User, "passwordHash">;

@Injectable()
export class UsersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  findForPasswordLogin(email: string): Promise<PasswordLoginUser | null> {
    return this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        role: true,
      },
    });
  }

  findAuthUserById(id: string): Promise<SafeUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        role: true,
      },
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
