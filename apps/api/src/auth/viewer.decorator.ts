import type { AuthUser } from "@intrinsic/contracts";
import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { AuthenticatedRequest } from "./authenticated-request";

/**
 * The caller of a route readable with or without a session — the signed-in user, or `null` for a
 * Guest. Pair it with `OptionalCookieAuthGuard`; a Guest is derived from the absence of a session
 * and never becomes a row.
 */
export const Viewer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser | null => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.authUser ?? null;
  },
);
