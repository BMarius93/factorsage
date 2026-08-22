import type { AuthUser } from "@intrinsic/contracts";
import type { Request } from "express";

export type AuthenticatedRequest = Request & {
  authUser?: AuthUser;
};
