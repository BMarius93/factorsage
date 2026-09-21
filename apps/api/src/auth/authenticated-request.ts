import type { AuthUser } from "@intrinsic/contracts";
import type { Request } from "express";

export type AuthenticatedRequest = Request & {
  authUser?: AuthUser;
  /**
   * Compliance state for the resolved session, set by the same guard that set `authUser`.
   *
   * Kept beside the user rather than on it because it is not part of the `AuthUser` contract and
   * must never be serialized into a response. `LegalAcceptanceInterceptor` is its only reader;
   * its absence on an authenticated request is treated as "not accepted", so a guard that
   * forgets to set it fails closed.
   */
  legalAcceptance?: { readonly termsAccepted: boolean };
};
