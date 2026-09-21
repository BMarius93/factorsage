import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalLegalDocumentText,
  LEGAL_DOCUMENT_LIST,
  LEGAL_DOCUMENTS,
} from "./legal-documents.js";
import {
  LEGAL_ACCEPTANCE_BUNDLE,
  LEGAL_DOCUMENT_KINDS,
  LEGAL_OWNER_FACT_IDS,
  LEGAL_OWNER_FACT_LIST,
  legalFactsReferencedBy,
  legalReleaseReadiness,
  REQUIRED_TERMS_VERSION,
} from "./legal.js";

/**
 * What makes a stored acceptance mean something.
 *
 * The first test is the load-bearing one: it recomputes every document's digest from its text and
 * compares it with the pinned value. Editing a sentence without bumping the version and running
 * `pnpm legal:hashes` fails here, which is what stops a past user's recorded acceptance quietly
 * coming to refer to a text they never read.
 *
 * The rest are the claims the implementation makes about this copy that a reviewer should not
 * have to take on trust: that no owner detail has been invented, that the liability wording keeps
 * its statutory carve-out, and that nothing has been marked approved.
 */
describe("legal documents", () => {
  it("pins the digest of every document's canonical text", () => {
    for (const document of LEGAL_DOCUMENT_LIST) {
      const expected = createHash("sha256")
        .update(canonicalLegalDocumentText(document), "utf8")
        .digest("hex");

      expect(
        document.contentHash,
        `${document.kind}@${document.version} digest is stale or missing — run \`pnpm legal:hashes\``,
      ).toBe(expected);
    }
  });

  it("covers every declared document kind exactly once, on its own route", () => {
    expect(LEGAL_DOCUMENT_LIST).toHaveLength(LEGAL_DOCUMENT_KINDS.length);
    const routes = LEGAL_DOCUMENT_LIST.map((document) => document.route);
    expect(new Set(routes).size).toBe(routes.length);
    for (const kind of LEGAL_DOCUMENT_KINDS) {
      expect(LEGAL_DOCUMENTS[kind].kind).toBe(kind);
    }
  });

  it("requires a Terms version that the Terms document actually publishes", () => {
    // The required version is deliberately a separate constant so a typo fix does not force every
    // customer through an acceptance screen. It must still name a version that exists.
    expect(REQUIRED_TERMS_VERSION).toBe(LEGAL_DOCUMENTS.TERMS.version);
  });

  it("records the Risk Disclosure as accepted and the Privacy Policy as presented", () => {
    // A privacy notice is information. Recording it as an acceptance would misrepresent it as a
    // blanket consent to every processing purpose.
    expect(LEGAL_ACCEPTANCE_BUNDLE).toEqual([
      { kind: "TERMS", record: "ACCEPTED" },
      { kind: "RISK_DISCLOSURE", record: "ACCEPTED" },
      { kind: "PRIVACY", record: "NOTICE_PRESENTED" },
    ]);
  });

  it("invents no operator detail: every owner fact is still a placeholder", () => {
    // The repository is public. A committed company name, address or mailbox would be either an
    // invention or a disclosure, and both are forbidden by the handoff.
    const referenced = new Set(
      LEGAL_DOCUMENT_LIST.flatMap((document) =>
        document.sections.flatMap((section) => [
          ...legalFactsReferencedBy(section.heading),
          ...section.paragraphs.flatMap(legalFactsReferencedBy),
          ...(section.list ?? []).flatMap(legalFactsReferencedBy),
        ]),
      ),
    );

    // Each placeholder used must be a declared fact with an owner and an environment variable.
    for (const id of referenced) {
      expect(LEGAL_OWNER_FACT_IDS).toContain(id);
    }
    // And the facts that block a release are all genuinely referenced by the copy, so the release
    // gate cannot be satisfied by a variable nothing reads.
    for (const fact of LEGAL_OWNER_FACT_LIST.filter(
      (candidate) => candidate.requiredForRelease,
    )) {
      expect(
        referenced.has(fact.id),
        `${fact.id} blocks a release but no document references it`,
      ).toBe(true);
    }
  });

  it("never claims a disclaimer removes liability or regulatory obligation", () => {
    const allText = LEGAL_DOCUMENT_LIST.flatMap((document) =>
      document.sections.flatMap((section) => [
        ...section.paragraphs,
        ...(section.list ?? []),
      ]),
    ).join("\n");

    // Affirmative claims only. The copy legitimately *denies* several of these — "does not
    // guarantee", "no blanket policy" — so the check looks for the assertion, not the topic.
    for (const forbidden of [
      "all sales are final",
      "no refunds",
      "we accept no liability",
      "under no circumstances",
      "you waive",
      "you agree to waive",
      "we never share your data",
      "we guarantee",
      "fully compliant",
      "legally certified",
    ]) {
      expect(
        allText.toLowerCase().includes(forbidden),
        `copy must not contain "${forbidden}"`,
      ).toBe(false);
    }

    // And the statements that must be present, because they are what keeps the exclusion lawful
    // and the performance claims honest.
    expect(allText).toContain("mandatory consumer rights");
    expect(allText).toContain("do not guarantee future returns");

    // Both liability clauses must carry the statutory carve-out in the same section.
    for (const kind of ["TERMS", "RISK_DISCLOSURE"] as const) {
      const section = LEGAL_DOCUMENTS[kind].sections.find((candidate) =>
        candidate.paragraphs.some((paragraph) =>
          paragraph.includes("excludes liability"),
        ),
      );
      expect(section, `${kind} must have a liability section`).toBeDefined();
      expect(
        section?.paragraphs.some((paragraph) =>
          paragraph.includes("cannot lawfully be excluded or limited"),
        ),
        `${kind} must keep the statutory carve-out beside the exclusion`,
      ).toBe(true);
      expect(
        section?.paragraphs.some((paragraph) =>
          /mandatory (consumer )?rights|rights as a consumer/i.test(paragraph),
        ),
        `${kind} must say mandatory consumer rights are unaffected`,
      ).toBe(true);
    }
  });

  it("reports every unresolved fact and every draft document as a release blocker", () => {
    const blockers = legalReleaseReadiness({}, LEGAL_DOCUMENT_LIST);

    // Nothing is approved yet, and no fact is supplied, so the gate must refuse a release.
    expect(blockers.length).toBe(
      LEGAL_OWNER_FACT_LIST.filter((fact) => fact.requiredForRelease).length +
        LEGAL_DOCUMENT_LIST.length,
    );
    expect(blockers.every((blocker) => blocker.detail.trim().length > 0)).toBe(
      true,
    );
  });

  it("clears a fact blocker only when the fact is actually supplied", () => {
    const blankish = legalReleaseReadiness({ LEGAL_ENTITY_NAME: "   " }, [
      LEGAL_DOCUMENTS.TERMS,
    ]);
    expect(
      blankish.some((blocker) => blocker.subject === "LEGAL_ENTITY_NAME"),
    ).toBe(true);

    const supplied = legalReleaseReadiness({ LEGAL_ENTITY_NAME: "Example" }, [
      LEGAL_DOCUMENTS.TERMS,
    ]);
    expect(
      supplied.some((blocker) => blocker.subject === "LEGAL_ENTITY_NAME"),
    ).toBe(false);
  });
});
