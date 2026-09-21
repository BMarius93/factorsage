import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot } from "@intrinsic/config";
import {
  canonicalLegalDocumentText,
  LEGAL_DOCUMENT_LIST,
} from "@intrinsic/contracts";

/**
 * Regenerates `packages/contracts/src/legal-document-hashes.ts`.
 *
 * `pnpm legal:hashes`. Run it after editing any legal copy, together with a version bump when the
 * change is material: the digest is what an acceptance event stores, and
 * `legal-documents.test.ts` fails whenever the file is stale, so this is the only way the copy and
 * the evidence stay in step.
 *
 * It writes nothing else and takes no arguments, so it is safe to run at any time; a clean tree
 * after running it means the pinned digests already match the copy.
 */
function main(): void {
  const entries = LEGAL_DOCUMENT_LIST.map((document) => {
    const text = canonicalLegalDocumentText(document);
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    return { key: `${document.kind}@${document.version}`, hash };
  }).sort((a, b) => a.key.localeCompare(b.key));

  const body = entries
    .map((entry) => `  "${entry.key}":\n    "${entry.hash}",`)
    .join("\n");

  const file = `/**
 * SHA-256 digests of the canonical text of every legal document version.
 *
 * **Generated. Do not edit by hand — run \`pnpm legal:hashes\`.**
 *
 * Keyed by \`KIND@version\`. A digest is what an acceptance event stores, so it is what makes the
 * event resolve to the exact text that was accepted. It lives in its own generated file rather
 * than beside the copy for two reasons: regenerating it produces a diff that is obviously
 * mechanical, and \`legal-documents.test.ts\` recomputes every entry, so editing the copy without
 * regenerating fails the build instead of silently re-pointing a past acceptance.
 */
export const LEGAL_DOCUMENT_CONTENT_HASHES: Readonly<Record<string, string>> = {
${body}
};
`;

  const root = findWorkspaceRoot();
  if (!root) {
    throw new Error(
      "Cannot locate the workspace root; run `pnpm legal:hashes` from inside the checkout.",
    );
  }
  const target = join(root, "packages/contracts/src/legal-document-hashes.ts");
  writeFileSync(target, file, "utf8");
  process.stdout.write(
    `Wrote ${entries.length} legal document digests to ${target}\n`,
  );
}

main();
