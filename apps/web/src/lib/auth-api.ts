import type { AuthUser, LoginRequest } from "@intrinsic/contracts";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

async function parseAuthUser(response: Response): Promise<AuthUser> {
  const user = (await response.json()) as Partial<AuthUser>;
  if (
    typeof user.id !== "string" ||
    typeof user.email !== "string" ||
    (user.role !== "USER" && user.role !== "ADMIN")
  ) {
    throw new Error("Invalid authentication response");
  }
  return user as AuthUser;
}

export async function login(request: LoginRequest): Promise<AuthUser> {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error("Login failed");
  }
  return parseAuthUser(response);
}

export async function getAuthUser(): Promise<AuthUser | null> {
  const response = await fetch(`${API_BASE_URL}/auth/me`, {
    credentials: "include",
    cache: "no-store",
  });

  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error("Authentication check failed");
  }
  return parseAuthUser(response);
}

export async function logout(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error("Logout failed");
  }
}
