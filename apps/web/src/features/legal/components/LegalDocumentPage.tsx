import {
  LEGAL_OWNER_FACTS,
  legalDocument,
  type LegalDocument,
  type LegalDocumentKind,
} from "@intrinsic/contracts";
import { PageContainer } from "../../../components/layout/PageContainer";
import { PageHeader } from "../../../components/ui/PageHeader";
import { Notice } from "../../../components/ui/Notice";
import pageStyles from "../../../components/ui/page.module.css";
import { legalTextRuns } from "../owner-facts";
import styles from "./LegalDocumentPage.module.css";

/**
 * The one renderer for every public legal document.
 *
 * Every page is the same server-rendered component over the versioned registry in
 * `@intrinsic/contracts`, which is what makes the six pages consistent and what makes "the text
 * on screen is the text whose digest an acceptance recorded" true rather than approximately true.
 *
 * Three properties it is built for, because the acceptance checklist asks for each by name:
 *
 * - **Readable by anyone.** It is a server component with no API call and no session dependency,
 *   so it renders for a Guest, for an expired or malformed session, for somebody who has declined
 *   the Terms, and with optional storage refused.
 * - **Printable.** Real headings, real paragraphs, a reading measure and a print stylesheet, so
 *   `Ctrl+P` produces the document rather than the application chrome.
 * - **Honest about its status.** A draft carries a preview banner, and every unresolved operator
 *   fact renders as a marker naming the fact and who owns supplying it, rather than as a gap.
 */
export function LegalDocumentPage({
  kind,
  children,
}: {
  readonly kind: LegalDocumentKind;
  /** Interactive content belonging to this page — cookie settings, a request form. */
  readonly children?: React.ReactNode;
}) {
  const document = legalDocument(kind);

  return (
    <PageContainer width="reading">
      <div className={pageStyles.stack}>
        <PageHeader
          title={document.title}
          lead={document.summary}
          variant="plain"
          testId={`legal-${kind.toLowerCase()}`}
        />

        <article className={styles.document} data-testid="legal-document">
          <DocumentStatus document={document} />

          <dl className={styles.meta}>
            <div className={styles.metaItem}>
              <dt>Version</dt>
              <dd data-testid="legal-document-version">{document.version}</dd>
            </div>
            <div className={styles.metaItem}>
              <dt>Effective</dt>
              <dd>{document.effectiveDate}</dd>
            </div>
            <div className={styles.metaItem}>
              <dt>Status</dt>
              <dd>{document.status === "APPROVED" ? "Published" : "Draft"}</dd>
            </div>
          </dl>

          {document.sections.map((section) => (
            <section
              className={styles.section}
              key={section.id}
              id={section.id}
              aria-labelledby={`${section.id}-heading`}
            >
              <h2 className={styles.heading} id={`${section.id}-heading`}>
                {section.heading}
              </h2>
              {section.paragraphs.map((paragraph, index) => (
                <p className={styles.paragraph} key={index}>
                  <Paragraph text={paragraph} />
                </p>
              ))}
              {section.list ? (
                <ul className={styles.list}>
                  {section.list.map((entry, index) => (
                    <li key={index}>
                      <Paragraph text={entry} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {section.pending ? (
                <p
                  className={styles.pending}
                  data-testid="legal-pending-review"
                >
                  <span className={styles.pendingTag}>
                    Pending review · {section.pending.ownerInput}
                  </span>{" "}
                  {section.pending.note}
                </p>
              ) : null}
            </section>
          ))}
        </article>

        {children}
      </div>
    </PageContainer>
  );
}

/**
 * The preview banner.
 *
 * Deliberately loud and deliberately at the top. A draft legal page that looked published is the
 * single worst outcome of this work: somebody would rely on it. The release-build guard is the
 * mechanism that stops it shipping; this is what stops it being misread in the meantime.
 */
function DocumentStatus({ document }: { readonly document: LegalDocument }) {
  if (document.status === "APPROVED") {
    return null;
  }
  return (
    <Notice
      tone="warning"
      title="Draft — not approved for publication"
      testId="legal-draft-banner"
    >
      <p>
        This wording has not been through owner and legal review. It describes
        what FactorSage actually does and is written to be corrected, not relied
        on. Passages still waiting on a decision are marked in place, and
        details the operator has not supplied appear as placeholders.
      </p>
      <p>
        A release build refuses to compile while any of that is outstanding, so
        this page cannot reach production in this state.
      </p>
    </Notice>
  );
}

/** Renders one paragraph, substituting owner facts and marking the ones still missing. */
function Paragraph({ text }: { readonly text: string }) {
  return (
    <>
      {legalTextRuns(text).map((run, index) =>
        run.kind === "text" ? (
          <span key={index}>{run.value}</span>
        ) : run.value ? (
          <span key={index}>{run.value}</span>
        ) : (
          <mark
            className={styles.placeholder}
            key={index}
            data-testid="legal-placeholder"
            title={`Owner input ${LEGAL_OWNER_FACTS[run.id].ownerInput}: ${LEGAL_OWNER_FACTS[run.id].label}`}
          >
            [{LEGAL_OWNER_FACTS[run.id].label} — pending{" "}
            {LEGAL_OWNER_FACTS[run.id].ownerInput}]
          </mark>
        ),
      )}
    </>
  );
}
