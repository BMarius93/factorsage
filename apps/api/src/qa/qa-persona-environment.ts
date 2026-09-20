/**
 * Where the manual QA-persona tooling is allowed to point, and nowhere else.
 *
 * `pnpm qa:seed` and `pnpm qa:reset` exist for **manual release testing against the development
 * stack**, so unlike `pnpm test:users:seed` — which targets `TEST_DATABASE_URL`, the database the
 * hermetic Playwright stack runs on — they target the database `pnpm dev:api` serves. That is the
 * only reason this module exists: the seeding logic itself is already shared
 * (`../auth/seed-qa-users.ts`), and duplicating it for a second database would be the mistake.
 *
 * Pointing a tool that **deletes rows** at the developer's own database raises the stakes, so the
 * refusals here are mechanical rather than advisory, and they are ordered cheapest-and-most-
 * catastrophic first. Nothing in this file opens a connection: a misconfiguration must be reported
 * before a client exists that could act on it. The same shape as
 * `../qa-matrix/matrix-environment.ts`, for the same reason.
 */

/** Optional override, for pointing the tooling at a non-default local QA database. */
export const QA_PERSONA_DATABASE_URL_ENV = "QA_PERSONA_DATABASE_URL";

/** Deliberate opt-in for the one case a QA database legitimately is not on this machine. */
export const QA_PERSONA_ALLOW_REMOTE_HOST_ENV = "QA_PERSONA_ALLOW_REMOTE_HOST";

/** Hosts the QA tooling may write to without an explicit override. */
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "host.docker.internal",
  "postgres",
]);

export class QaPersonaEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaPersonaEnvironmentError";
  }
}

export type QaPersonaEnvironment = {
  /** The database the personas are seeded into and reset in. */
  readonly databaseUrl: string;
  /** Its own name, e.g. `intrinsic_value`. Printed so the operator sees where they are acting. */
  readonly databaseName: string;
  readonly host: string;
  /** Which variable supplied {@link databaseUrl}, for the banner and for error messages. */
  readonly source: typeof QA_PERSONA_DATABASE_URL_ENV | "DATABASE_URL";
};

/** A URL with any credentials removed, so a message can name it without leaking a password. */
export function redactDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "<unparseable>";
  }
}

export const PRODUCTION_QA_PERSONA_MESSAGE =
  "Refusing to run the QA persona tooling: NODE_ENV is production. These commands create " +
  "accounts whose passwords live in a developer environment file — one of them an administrator " +
  "— and `pnpm qa:reset` deletes the content they own. Neither may ever happen against a " +
  "production database.";

/**
 * Resolves the QA persona database, refusing every target that is not plainly a local QA one.
 *
 * Three independent refusals, any one of which is enough:
 *
 * 1. `NODE_ENV=production` — checked first, before a credential is read or a URL is parsed.
 * 2. a non-PostgreSQL or database-less URL — a typo that would otherwise fail later and less
 *    clearly;
 * 3. a host that is not this machine — the check that actually stands between `pnpm qa:reset` and
 *    somebody's shared staging database. It is overridable only by setting
 *    `QA_PERSONA_ALLOW_REMOTE_HOST=true` on purpose, which nothing does by default.
 */
export function resolveQaPersonaEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): QaPersonaEnvironment {
  if (env.NODE_ENV?.trim() === "production") {
    throw new QaPersonaEnvironmentError(PRODUCTION_QA_PERSONA_MESSAGE);
  }

  const override = env[QA_PERSONA_DATABASE_URL_ENV]?.trim();
  const source = override ? QA_PERSONA_DATABASE_URL_ENV : "DATABASE_URL";
  const raw = override ?? env.DATABASE_URL?.trim();

  if (!raw) {
    throw new QaPersonaEnvironmentError(
      "The QA persona tooling needs a database. Set DATABASE_URL in the repository-root .env — " +
        "the same database `pnpm dev:api` serves — or set " +
        `${QA_PERSONA_DATABASE_URL_ENV} to point somewhere else.`,
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new QaPersonaEnvironmentError(`${source} is not a valid URL.`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new QaPersonaEnvironmentError(
      `${source} must be a postgresql:// URL; received \`${url.protocol}//…\`.`,
    );
  }

  const databaseName = url.pathname.replace(/^\//, "");
  if (!databaseName) {
    throw new QaPersonaEnvironmentError(`${source} names no database.`);
  }

  const host = url.hostname;
  const allowRemote = env[QA_PERSONA_ALLOW_REMOTE_HOST_ENV]?.trim() === "true";
  if (!LOCAL_HOSTS.has(host) && !allowRemote) {
    throw new QaPersonaEnvironmentError(
      `Refusing to run the QA persona tooling against \`${redactDatabaseUrl(raw)}\`: ` +
        `\`${host}\` is not this machine. QA personas are local development infrastructure and ` +
        "`pnpm qa:reset` deletes the content they own, so a remote target is refused rather than " +
        `confirmed. Set ${QA_PERSONA_ALLOW_REMOTE_HOST_ENV}=true only if you are certain.`,
    );
  }

  return { databaseUrl: raw, databaseName, host, source };
}
