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

/** The monorepo root: the nearest directory above the working directory with the workspace file. */
export function repositoryRoot(): string | undefined {
  let directory = resolve(process.cwd());
  while (true) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

/** Loads the repository-root `.env` once so a local run picks up the QA persona variables. */
function loadRootEnv(): void {
  if (loaded) {
    return;
  }
  loaded = true;

  const root = repositoryRoot();
  const envFile = root === undefined ? undefined : join(root, ".env");
  if (envFile !== undefined && existsSync(envFile)) {
    loadEnvFile(envFile);
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
