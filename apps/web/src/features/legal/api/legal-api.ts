import type {
  LegalAcceptanceRequest,
  LegalAcceptanceStatusResponse,
  LegalRequestListResponse,
  LegalRequestReceipt,
  LegalRequestSubmission,
} from "@intrinsic/contracts";
import { apiGet, apiPost } from "../../../lib/api/client";

/**
 * The legal endpoints, in the shape every other feature's API module uses.
 *
 * All four are outside the acceptance gate on the server, which is what lets the gate screen
 * itself and the request forms work for a user who has not accepted.
 */

export function fetchLegalAcceptance(options?: {
  signal?: AbortSignal;
}): Promise<LegalAcceptanceStatusResponse> {
  return apiGet<LegalAcceptanceStatusResponse>("/legal/acceptance", {
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Records acceptance and returns the state after the write.
 *
 * The response is the server's answer to "is anything still outstanding", so the caller never
 * has to infer success from the absence of an error.
 */
export async function acceptLegalTerms(
  request: LegalAcceptanceRequest,
): Promise<LegalAcceptanceStatusResponse> {
  const response = await apiPost<LegalAcceptanceStatusResponse>(
    "/legal/acceptance",
    request,
  );
  if (!response) {
    // `apiPost` returns null only for a `204`, which this endpoint never sends.
    throw new Error("The server did not return the acceptance state.");
  }
  return response;
}

/** Submits a request and returns its durable receipt. */
export async function submitLegalRequest(
  submission: LegalRequestSubmission,
): Promise<LegalRequestReceipt> {
  const receipt = await apiPost<LegalRequestReceipt>(
    "/legal/requests",
    submission,
  );
  if (!receipt) {
    throw new Error("The server did not return a receipt for this request.");
  }
  return receipt;
}

export function fetchLegalRequests(options?: {
  signal?: AbortSignal;
}): Promise<LegalRequestListResponse> {
  return apiGet<LegalRequestListResponse>("/legal/requests", {
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}
