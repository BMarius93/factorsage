/**
 * SHA-256 digests of the canonical text of every legal document version.
 *
 * **Generated. Do not edit by hand — run `pnpm legal:hashes`.**
 *
 * Keyed by `KIND@version`. A digest is what an acceptance event stores, so it is what makes the
 * event resolve to the exact text that was accepted. It lives in its own generated file rather
 * than beside the copy for two reasons: regenerating it produces a diff that is obviously
 * mechanical, and `legal-documents.test.ts` recomputes every entry, so editing the copy without
 * regenerating fails the build instead of silently re-pointing a past acceptance.
 */
export const LEGAL_DOCUMENT_CONTENT_HASHES: Readonly<Record<string, string>> = {
  "CANCELLATION_AND_REFUNDS@0.1.0-draft":
    "48618277824f898a30088e8ad929ecd90408e7e4bc2b40b24410c5ac391c1606",
  "CONTACT@0.1.0-draft":
    "cf8022bf3cf5304b2e63829bdca2562e9451eef372ae1761dcc2fd30bccb9fd8",
  "COOKIES@0.1.0-draft":
    "4e92bb180a815eddc337df37f381dfc605a93a9a6cf737d36da44995e333a9f9",
  "PRIVACY@0.1.0-draft":
    "964e277c85bbd5c6b1446c0fedb1bcf764417a724874b690cbd94f3aae1c09bb",
  "RISK_DISCLOSURE@0.1.0-draft":
    "cdc089ab13365535091262bf029d308d0d9848da4d6d6d89786760da58809844",
  "TERMS@0.1.0-draft":
    "50dcf74196936320aa8fc5a908232dfdce32cf09dcc6e663c4cc4b8f17301074",
};
