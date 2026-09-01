import type {
  AuthProvidersResponse,
  AuthUser,
  LoginRequest,
  RegisterRequest,
  RegisterResponse,
  ResendVerificationResponse,
  VerifyEmailResponse,
} from "@intrinsic/contracts";
import { API_BASE_URL, ApiError, apiGet, apiPost } from "../../../lib/api/client";

/**
 * The API owns Google sign-in, so the button is a plain top-level navigation to the API rather
 * than a fetch: the provider redirect and the resulting HttpOnly cookie both need a real
 * browser navigation.
 */
export const GOOGLE_SIGN_IN_URL = `${API_BASE_URL}/auth/google`;

function assertAuthUser(value: unknown): AuthUser {
  const user = value as Partial<AuthUser> | null;
  if (
    !user ||
    typeof user.id !== "string" ||
    typeof user.email !== "string" ||
    (user.role !== "USER" && user.role !== "ADMIN")
  ) {
    throw new Error("Invalid authentication response");
  }
  return user as AuthUser;
}

export async function login(request: LoginRequest): Promise<AuthUser> {
  return assertAuthUser(await apiPost<AuthUser>("/auth/login", request));
}

export async function register(
  request: RegisterRequest,
): Promise<RegisterResponse> {
  await apiPost<RegisterResponse>("/auth/register", request);
  return { status: "verification_sent" };
}

export async function verifyEmail(token: string): Promise<VerifyEmailResponse> {
  await apiPost<VerifyEmailResponse>("/auth/verify-email", { token });
  return { status: "verified" };
}

export async function resendVerification(
  email: string,
): Promise<ResendVerificationResponse> {
  await apiPost<ResendVerificationResponse>("/auth/resend-verification", {
    email,
  });
  return { status: "accepted" };
}

export function getAuthProviders(): Promise<AuthProvidersResponse> {
  return apiGet<AuthProvidersResponse>("/auth/providers");
}

/** `null` for an anonymous browser; the API answers `401` rather than failing. */
export async function getAuthUser(): Promise<AuthUser | null> {
  try {
    return assertAuthUser(await apiGet<AuthUser>("/auth/me"));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function logout(): Promise<void> {
  await apiPost<null>("/auth/logout", null);
}
