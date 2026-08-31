/**
 * Shared HTTP mechanics for calls into the IntrinsicValue API.
 *
 * Feature modules own their own endpoints and response shapes; this file owns only the base URL,
 * credential handling, and error translation so those cannot drift per feature.
 */

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiRequestOptions = {
  /** Query parameters; `undefined` values are omitted rather than serialized. */
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly signal?: AbortSignal;
};

function buildUrl(path: string, query: ApiRequestOptions["query"]): string {
  const url = new URL(path.replace(/^\//, ""), `${API_BASE_URL}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Performs a JSON GET against the API and rejects with `ApiError` on a non-2xx response. */
export async function apiGet<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const response = await fetch(buildUrl(path, options.query), {
    credentials: "include",
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    throw new ApiError(response.status, `Request to ${path} failed`);
  }
  return (await response.json()) as T;
}
