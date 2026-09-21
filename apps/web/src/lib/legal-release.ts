/**
 * The build-time guard that stops an unreviewed legal page reaching production.
 *
 * `docs/legal/implementation-spec.md` section 8 asks for exactly this: a narrowly scoped
 * readiness check that fails the intended public release when required operator facts or approved
 * wording are missing, **without** breaking local development. A check that broke `pnpm dev` is
 * a check somebody switches off, and a draft page has to stay reviewable in a browser before it
 * can be approved.
 *
 * So it fires only in the `next build` production phase **and** only when the build declares
 * itself a release with `FACTORSAGE_RELEASE_BUILD=true` — the same flag
 * `release-build.ts` uses for the public API URL, set by `docker/web.Dockerfile`. Every other
 * build, including the repository's own validation gate and CI, compiles unaffected and renders
 * the draft banners and placeholders that make the pages reviewable.
 *
 * Two classes of blocker, and both are real:
 *
 * - **an unresolved operator fact** — the contracting entity, its address, its identifiers, the
 *   monitored contacts, the supervisory authority, the governing law, the dispute-resolution
 *   information. Publishing a paid service without them is what the E-commerce and Consumer
 *   Rights directives are about, and the repository cannot invent them;
 * - **a document still marked `DRAFT`** — wording nobody with the authority to approve it has
 *   approved. It is deliberately not possible to satisfy this by editing a flag alone: approving
 *   a document means changing its status *and* its version, which changes its digest, which the
 *   contracts test recomputes.
 *
 * Imported by `next.config.ts`, so like `release-build.ts` it may depend on nothing but
 * `@intrinsic/contracts` and the standard library — the web app may not import `@intrinsic/config`
 * (AGENTS.md dependency rules).
 */

import {
  LEGAL_DOCUMENT_LIST,
  LEGAL_OWNER_FACT_LIST,
  legalReleaseReadiness,
  type LegalOwnerFactId,
} from "@intrinsic/contracts";
import { isReleaseBuild, PRODUCTION_BUILD_PHASE } from "./release-build";

type BuildEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Reads each fact from the environment by the variable the contract registry names.
 *
 * Unlike `features/legal/owner-facts.ts`, which must spell the variables out literally so
 * `next build` can inline them into the browser bundle, this runs in the Node build process and
 * may index dynamically. That is the point: the guard reads the registry, so a fact added there
 * is checked without anybody remembering to add it here too.
 */
export function resolveLegalOwnerFacts(
  env: BuildEnvironment,
): Partial<Record<LegalOwnerFactId, string | undefined>> {
  const resolved: Partial<Record<LegalOwnerFactId, string | undefined>> = {};
  for (const fact of LEGAL_OWNER_FACT_LIST) {
    resolved[fact.id] = env[fact.envVariable];
  }
  return resolved;
}

/**
 * Throws when a declared release build would publish draft copy or an unresolved placeholder.
 *
 * The message lists every blocker with the owner-input entry that owns it, so the failure is
 * directly actionable rather than "something about legal".
 */
export function assertLegalReleaseReadiness(
  env: BuildEnvironment,
  phase: string,
): void {
  if (phase !== PRODUCTION_BUILD_PHASE || !isReleaseBuild(env)) {
    return;
  }

  const blockers = legalReleaseReadiness(
    resolveLegalOwnerFacts(env),
    LEGAL_DOCUMENT_LIST,
  );
  if (blockers.length === 0) {
    return;
  }

  const detail = blockers
    .map(
      (blocker) =>
        `  - ${blocker.kind}${blocker.ownerInput ? ` [${blocker.ownerInput}]` : ""} ${blocker.detail}`,
    )
    .join("\n");

  throw new Error(
    "Invalid web release build: the legal pages are not ready to publish.\n" +
      `${blockers.length} blocker(s):\n${detail}\n` +
      "docs/legal/owner-inputs-and-review.md is the register these identifiers refer to. " +
      "Run `pnpm legal:check` to see this list without building.",
  );
}
