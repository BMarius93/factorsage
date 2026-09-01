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
    /** Stable machine-readable code from the API, when it sends one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Turns a non-2xx response into an `ApiError`, preferring the API's own message and code.
 *
 * A body that is missing or not JSON is not an error in itself: the status is still meaningful,
 * so the caller gets a usable failure rather than a parse exception.
 */
async function toApiError(response: Response, path: string): Promise<ApiError> {
  let message: string | undefined;
  let code: string | undefined;

  try {
    const body = (await response.json()) as {
      message?: unknown;
      code?: unknown;
    };
    if (typeof body.message === "string") {
      message = body.message;
    }
    if (typeof body.code === "string") {
      code = body.code;
    }
  } catch {
    // Fall through to the status-only error.
  }

  return new ApiError(
    response.status,
    message ?? `Request to ${path} failed`,
    code,
  );
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
    throw await toApiError(response, path);
  }
  return (await response.json()) as T;
}

/** Performs a JSON POST against the API and rejects with `ApiError` on a non-2xx response. */
export async function apiPost<T>(
  path: string,
  body: unknown,
  options: ApiRequestOptions = {},
): Promise<T | null> {
  const response = await fetch(buildUrl(path, options.query), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    throw await toApiError(response, path);
  }
  // 204 responses (logout) have no body to parse.
  return response.status === 204 ? null : ((await response.json()) as T);
}
