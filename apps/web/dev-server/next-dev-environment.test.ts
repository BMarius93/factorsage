// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BILLING_PERSONA_PASSWORD_ENV } from "@intrinsic/testing/billing-personas";
import {
  E2E_TEST_CREDENTIAL_VARIABLES,
  e2eChildEnvironment,
  e2eEgressGuardPath,
} from "@intrinsic/testing/e2e-stack";
import {
  TEST_PERSONA_LIST,
  personaCredentialEnvNames,
} from "@intrinsic/testing/personas";
import { describe, expect, it } from "vitest";
import {
  NEXT_DEV_INHERITED_PREFIXES,
  NEXT_DEV_INHERITED_VARIABLES,
  nextDevEnvironment,
  withheldFromNextDev,
} from "./next-dev-environment";

/**
 * What `next dev` is allowed to receive.
 *
 * `next dev` writes its environment into `.next/dev/cache/turbopack`, so anything it is handed ends
 * up on disk. These tests hold the rule that it is handed an allowlist — and they are written
 * against a parent environment that holds every secret this repository knows about, because the
 * failure being guarded against is somebody passing the parent environment through again.
 */

const REPOSITORY_ROOT = resolve(__dirname, "../../..");

/** Values chosen so that finding one anywhere in a result is unambiguous. */
const secret = (name: string) => `leak-${name.toLowerCase()}-9f3a71c2`;

/** The six test-account passwords, written out: the variables this boundary exists for. */
const QA_PASSWORD_VARIABLES = [
  "QA_BILLING_PASSWORD",
  "QA_FREE_PASSWORD",
  "QA_STARTER_PASSWORD",
  "QA_USER_PASSWORD",
  "QA_ADMIN_PASSWORD",
  "QA_DOWNGRADED_PASSWORD",
];

/** Everything else in `.env.example`, or in a cloud session, that is a credential. */
const OTHER_SECRET_VARIABLES = [
  "ADMIN_PASSWORD",
  "AUTH_JWT_SECRET",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "POSTGRES_PASSWORD",
  "REDIS_URL",
  "FMP_API_KEY",
  "LIVE_FMP_API_KEY",
  "GOOGLE_CLIENT_SECRET",
  "SMTP_PASSWORD",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_API_KEY",
  "SANDBOX_STRIPE_SECRET_KEY",
  // Nothing this repository defines: whatever else a shell or an agent session happens to hold.
  "GITHUB_TOKEN",
  "SOME_VENDOR_SESSION",
];

/** A shell, or a Claude cloud session, with everything exported. */
function hostileParent(): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/developer",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "xterm-256color",
    NODE_OPTIONS: "--max-old-space-size=4096",
    NEXT_PUBLIC_API_BASE_URL: "http://localhost:3001",
    NEXT_PUBLIC_LEGAL_ENTITY_NAME: "Example Ltd",
    QA_FREE_EMAIL: "qa-free@factorsage.test",
    ...Object.fromEntries(
      [...QA_PASSWORD_VARIABLES, ...OTHER_SECRET_VARIABLES].map((name) => [
        name,
        secret(name),
      ]),
    ),
  };
}

function expectNoSecret(environment: Record<string, string>): void {
  const text = JSON.stringify(environment);
  for (const name of [...QA_PASSWORD_VARIABLES, ...OTHER_SECRET_VARIABLES]) {
    expect(Object.keys(environment), name).not.toContain(name);
    // Not under another name either.
    expect(text, name).not.toContain(secret(name));
  }
}

describe("nextDevEnvironment", () => {
  it("gives next dev what it takes to run, and the web app's public configuration", () => {
    expect(nextDevEnvironment(hostileParent())).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/developer",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      NODE_OPTIONS: "--max-old-space-size=4096",
      NEXT_PUBLIC_API_BASE_URL: "http://localhost:3001",
      NEXT_PUBLIC_LEGAL_ENTITY_NAME: "Example Ltd",
    });
  });

  it.each(QA_PASSWORD_VARIABLES)("withholds %s", (name) => {
    const environment = nextDevEnvironment({ ...hostileParent() });
    expect(Object.keys(environment)).not.toContain(name);
    expect(JSON.stringify(environment)).not.toContain(secret(name));
  });

  it("withholds every test credential the persona registries define", () => {
    // Derived, so a persona added to either registry is covered without touching this file…
    const fromRegistries = [
      ...TEST_PERSONA_LIST.map(
        (persona) => personaCredentialEnvNames(persona).password,
      ),
      BILLING_PERSONA_PASSWORD_ENV,
    ];
    // …and today that is exactly the six above.
    expect([...fromRegistries].sort()).toEqual(
      [...QA_PASSWORD_VARIABLES].sort(),
    );
    expect([...E2E_TEST_CREDENTIAL_VARIABLES].sort()).toEqual(
      [...QA_PASSWORD_VARIABLES].sort(),
    );

    const parent = Object.fromEntries(
      fromRegistries.map((name) => [name, secret(name)]),
    );
    expect(nextDevEnvironment(parent)).toEqual({});
  });

  it("withholds every other credential, and anything it has never heard of", () => {
    expectNoSecret(nextDevEnvironment(hostileParent()));
    expect(nextDevEnvironment({ A_VARIABLE_NOBODY_LISTED: "value" })).toEqual(
      {},
    );
  });

  it("does not let a credential in by giving it a public prefix", () => {
    const environment = nextDevEnvironment({
      NEXT_PUBLIC_QA_PASSWORD: "leak-1",
      NEXT_PUBLIC_QA_BILLING_PASSWORD: "leak-2",
      NEXT_PUBLIC_AUTH_JWT_SECRET: "leak-3",
      NEXT_PUBLIC_SESSION_TOKEN: "leak-4",
      NEXT_PUBLIC_FMP_API_KEY: "leak-5",
      NEXT_PUBLIC_API_BASE_URL: "http://localhost:3001",
    });
    expect(environment).toEqual({
      NEXT_PUBLIC_API_BASE_URL: "http://localhost:3001",
    });
  });

  it("leaves out a variable that is not set rather than passing an empty one", () => {
    expect(nextDevEnvironment({ PATH: "/bin", HOME: undefined })).toEqual({
      PATH: "/bin",
    });
  });

  it("names what it withheld without ever carrying a value", () => {
    const withheld = withheldFromNextDev(hostileParent());
    expect(withheld).toEqual(
      [
        ...QA_PASSWORD_VARIABLES,
        ...OTHER_SECRET_VARIABLES,
        "QA_FREE_EMAIL",
      ].sort(),
    );
    for (const name of [...QA_PASSWORD_VARIABLES, ...OTHER_SECRET_VARIABLES]) {
      expect(withheld.join(" ")).not.toContain(secret(name));
    }
  });
});

describe("the next dev allowlist", () => {
  it("lists no credential and nothing provider- or database-shaped", () => {
    const suspicious =
      /QA_|PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|DATABASE|REDIS|STRIPE|FMP|SMTP|GOOGLE|AUTH|ADMIN/i;
    expect(
      NEXT_DEV_INHERITED_VARIABLES.filter((name) => suspicious.test(name)),
    ).toEqual([]);
  });

  it("admits by prefix only the public web configuration and the locale", () => {
    expect([...NEXT_DEV_INHERITED_PREFIXES]).toEqual(["NEXT_PUBLIC_", "LC_"]);
  });

  it("passes nothing from .env.example but the public web configuration and NODE_ENV", () => {
    // Every variable the repository documents, commented out or not. A secret added to that file
    // later is therefore checked here the day it is added.
    const documented = [
      ...readFileSync(
        resolve(REPOSITORY_ROOT, ".env.example"),
        "utf8",
      ).matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm),
    ].map((match) => match[1] as string);
    expect(documented.length).toBeGreaterThan(100);
    expect(documented).toEqual(
      expect.arrayContaining([...QA_PASSWORD_VARIABLES, "AUTH_JWT_SECRET"]),
    );

    const passed = Object.keys(
      nextDevEnvironment(
        Object.fromEntries(documented.map((name) => [name, "value"])),
      ),
    );
    expect(passed.filter((name) => !name.startsWith("NEXT_PUBLIC_"))).toEqual([
      "NODE_ENV",
    ]);
    expect(
      passed.filter((name) => name.startsWith("NEXT_PUBLIC_")),
    ).not.toEqual([]);
  });
});

describe("the hermetic E2E web process", () => {
  /** The launcher's environment in a cloud session: everything ambient, test passwords included. */
  const launched = () =>
    e2eChildEnvironment({
      role: "web",
      repositoryRoot: REPOSITORY_ROOT,
      parentEnvironment: hostileParent(),
    });

  it("receives no test password from the launcher, and next dev none of the launcher's secrets", () => {
    // First boundary: the launcher blanks the test passwords for every role.
    const fromLauncher = launched();
    for (const name of QA_PASSWORD_VARIABLES) {
      expect(fromLauncher[name], name).toBe("");
    }

    // Second boundary: whatever else the launcher still carries, next dev gets the allowlist.
    expectNoSecret(nextDevEnvironment(fromLauncher));
  });

  it("still receives what makes it the hermetic web process", () => {
    const environment = nextDevEnvironment(launched());

    // The egress guard is preloaded through NODE_OPTIONS and reads these three.
    expect(environment.NODE_OPTIONS).toBe(
      `--require=${e2eEgressGuardPath(REPOSITORY_ROOT)} --max-old-space-size=4096`,
    );
    expect(environment.E2E_STACK_ROLE).toBe("web");
    expect(environment.E2E_STACK_MODE).toBe("standard");
    expect(environment.E2E_EGRESS_LOG).toMatch(/\.e2e-stack\/egress\.jsonl$/);
    expect(environment.NEXT_TELEMETRY_DISABLED).toBe("1");
    expect(environment.npm_config_update_notifier).toBe("false");
    expect(environment.NEXT_PUBLIC_API_BASE_URL).toBe("http://localhost:3001");
  });
});
