import type { BuiltInContentAdminResponse } from "@intrinsic/contracts";
import { apiGet } from "../../../lib/api/client";

/** Every built-in list, strategy and monitor, published or not. Administrators only. */
export function fetchBuiltInContent(options: { signal?: AbortSignal } = {}) {
  return apiGet<BuiltInContentAdminResponse>("/admin/built-ins", options);
}
