import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";

import {
  TEST_PERSONAS,
  personaCredentialEnvNames,
  type TestPersona,
  type TestPersonaName,
} from "@intrinsic/testing/personas";

export type { TestPersonaName };

export type QaPersonaCredentials = TestPersona & {
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
 * Credentials for one persistent test persona.
 *
 * The persona set, and each one's plan, role and storage-state path, come from the shared registry
 * in `@intrinsic/testing/personas` — imported through a dependency-free subpath, so the Playwright
 * harness reads the same table the seeder writes from without pulling the engine or the database
 * layer into the web app. Only the secrets come from the environment.
 *
 * Only the variable names ever appear in output: a missing value is reported by name so the
 * failure is actionable without printing anything secret.
 */
export function qaPersona(name: TestPersonaName): QaPersonaCredentials {
  const persona = TEST_PERSONAS[name];
  const names = personaCredentialEnvNames(persona);
  const email = read(names.email);
  const password = read(names.password);

  if (!email || !password) {
    throw new Error(
      `Playwright requires ${names.email} and ${names.password} for the ${name} persona. Set ` +
        "them in the repository root .env and run `pnpm test:personas:seed` before running the " +
        "suite. See ai/workflows/auth-testing.md.",
    );
  }

  return { ...persona, email, password };
}

/** Where each persona's signed-in state is kept. Git-ignored: these hold live session cookies. */
export const STORAGE_STATE = Object.fromEntries(
  Object.entries(TEST_PERSONAS).map(([name, persona]) => [
    name,
    persona.storageState,
  ]),
) as Record<TestPersonaName, string>;
