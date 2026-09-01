import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";

export type QaPersonaName = "QA_USER" | "QA_ADMIN";

export type QaPersonaCredentials = {
  readonly name: QaPersonaName;
  readonly email: string;
  readonly password: string;
};

let loaded = false;

/** Loads the repository-root `.env` once so a local run picks up the QA persona variables. */
function loadRootEnv(): void {
  if (loaded) {
    return;
  }
  loaded = true;

  let directory = resolve(process.cwd());
  while (true) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      const envFile = join(directory, ".env");
      if (existsSync(envFile)) {
        loadEnvFile(envFile);
      }
      return;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return;
    }
    directory = parent;
  }
}

function read(name: string): string | undefined {
  loadRootEnv();
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** The already-running stack under test; Playwright never starts one of its own. */
export function e2eBaseUrl(): string {
  return read("E2E_BASE_URL") ?? "http://localhost:3000";
}

/**
 * Credentials for a persistent QA persona.
 *
 * Only the variable names ever appear in output: a missing value is reported by name so the
 * failure is actionable without printing anything secret.
 */
export function qaPersona(name: QaPersonaName): QaPersonaCredentials {
  const email = read(`${name}_EMAIL`);
  const password = read(`${name}_PASSWORD`);

  if (!email || !password) {
    throw new Error(
      `Playwright requires ${name}_EMAIL and ${name}_PASSWORD. Set them in the repository ` +
        "root .env and run `pnpm test:users:seed` before running the suite. See " +
        "ai/workflows/auth-testing.md.",
    );
  }

  return { name, email, password };
}

export const STORAGE_STATE = {
  QA_USER: "playwright/.auth/user.json",
  QA_ADMIN: "playwright/.auth/admin.json",
} as const satisfies Record<QaPersonaName, string>;
