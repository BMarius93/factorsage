import { loadRootEnv } from "@intrinsic/config";
import {
  LEGAL_DOCUMENT_LIST,
  LEGAL_OWNER_FACT_LIST,
  legalReleaseReadiness,
  type LegalOwnerFactId,
} from "@intrinsic/contracts";

/**
 * `pnpm legal:check` — what still blocks publishing the legal pages.
 *
 * Reports rather than guesses. Every line names the owner-input entry that owns the gap, so the
 * output is directly usable as the launch-blocker list in a release report.
 *
 * Exit code 1 when anything is outstanding, so CI or a release script can gate on it. It is
 * deliberately **not** part of `pnpm lint`/`test`/`build`: a draft legal page must stay reviewable
 * locally, and a check that broke `pnpm dev` is a check somebody switches off. The web app's own
 * release-build guard (`apps/web/src/lib/legal-release.ts`) is what actually prevents an
 * unresolved placeholder reaching a production bundle.
 */
function main(): void {
  loadRootEnv();

  // Resolved from the same browser-visible variables `next build` inlines, so this reports what a
  // release built from this environment would actually publish.
  const resolved: Partial<Record<LegalOwnerFactId, string | undefined>> = {};
  for (const fact of LEGAL_OWNER_FACT_LIST) {
    resolved[fact.id] = process.env[fact.envVariable];
  }

  const blockers = legalReleaseReadiness(resolved, LEGAL_DOCUMENT_LIST);

  if (blockers.length === 0) {
    process.stdout.write(
      "Legal readiness: no blockers. Every required operator fact is resolved and every document is APPROVED.\n",
    );
    return;
  }

  process.stdout.write(
    `Legal readiness: ${blockers.length} blocker(s). These must be resolved before the legal pages are published.\n\n`,
  );
  for (const blocker of blockers) {
    const owner = blocker.ownerInput ? ` [${blocker.ownerInput}]` : "";
    process.stdout.write(`  ${blocker.kind}${owner} ${blocker.detail}\n`);
  }
  process.stdout.write(
    "\ndocs/legal/owner-inputs-and-review.md is the register these identifiers refer to.\n",
  );
  process.exitCode = 1;
}

main();
