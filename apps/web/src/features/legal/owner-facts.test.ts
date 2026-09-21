import { LEGAL_OWNER_FACT_LIST, legalDocument } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  legalTextRuns,
  ownerFact,
  RESOLVED_OWNER_FACT_SOURCES,
} from "./owner-facts";

/**
 * The two things that keep the placeholder mechanism honest.
 *
 * The first is structural: `next build` inlines `process.env.NEXT_PUBLIC_*` only where it can see
 * the property name written out, so the resolver spells each variable literally. That is exactly
 * the kind of duplication that rots, so it is checked against the contract registry rather than
 * reviewed.
 *
 * The second is substantive: nothing in this repository supplies an operator fact. A committed
 * company name, address or mailbox would be either an invention or a disclosure of the owner's
 * details into a public repository, and the handoff forbids both.
 */
describe("legal owner facts", () => {
  it("resolves every declared fact, and no fact is supplied in this repository", () => {
    for (const fact of LEGAL_OWNER_FACT_LIST) {
      // Unresolved here means the page shows a marker and a release build refuses to compile.
      expect(ownerFact(fact.id), fact.id).toBeUndefined();
    }
  });

  it("reads the environment variable the contract registry declares", () => {
    // The literal `process.env.X` spelling is the only thing `next build` can inline, so it is
    // duplicated here on purpose. A fact added to the registry without an entry is a compile
    // error (the map is total); an entry reading the wrong variable is this test.
    for (const fact of LEGAL_OWNER_FACT_LIST) {
      expect(RESOLVED_OWNER_FACT_SOURCES[fact.id].variable, fact.id).toBe(
        fact.envVariable,
      );
    }
  });

  it("splits a paragraph into text and unresolved fact runs, in order", () => {
    const runs = legalTextRuns(
      "FactorSage is operated by {{LEGAL_ENTITY_NAME}}, registered at {{REGISTERED_ADDRESS}}.",
    );

    expect(runs.map((run) => run.kind)).toEqual([
      "text",
      "fact",
      "text",
      "fact",
      "text",
    ]);
    expect(runs[0]).toEqual({
      kind: "text",
      value: "FactorSage is operated by ",
    });
    expect(runs[1]).toMatchObject({
      kind: "fact",
      id: "LEGAL_ENTITY_NAME",
      value: undefined,
    });
  });

  it("renders an unknown placeholder verbatim rather than swallowing it", () => {
    // A typo in the copy must be visible on the page, not silently disappear into nothing.
    const runs = legalTextRuns("Contact {{NOT_A_FACT}} today.");
    expect(runs).toEqual([
      { kind: "text", value: "Contact " },
      { kind: "text", value: "{{NOT_A_FACT}}" },
      { kind: "text", value: " today." },
    ]);
  });

  it("leaves text with no placeholders untouched", () => {
    const paragraph =
      legalDocument("RISK_DISCLOSURE").sections[0]?.paragraphs[0];
    expect(paragraph).toBeDefined();
    expect(legalTextRuns(paragraph ?? "")).toEqual([
      { kind: "text", value: paragraph },
    ]);
  });
});
