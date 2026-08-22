import type { UserRole } from "@intrinsic/contracts";
import { SetMetadata } from "@nestjs/common";

export const ROLES_KEY = "auth:roles";

export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
