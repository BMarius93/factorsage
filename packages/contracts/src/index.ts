export type HealthResponse = {
  status: "ok";
  service: "api";
};

export const USER_ROLES = ["USER", "ADMIN"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export type LoginRequest = {
  email: string;
  password: string;
};

export type AuthUser = {
  id: string;
  email: string;
  role: UserRole;
};

export type AdminHealthResponse = {
  status: "ok";
  role: "ADMIN";
};

export * from "./stock-data.js";
