import { randomBytes } from "node:crypto";
import {
  REQUIRED_TERMS_VERSION,
  type LegalAcceptanceStatusResponse,
  type LegalAcceptanceSurface,
  type LegalRequestKind,
  type LegalRequestReceipt,
  type LegalRequestSubmission,
} from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { acceptanceRows } from "./legal-acceptance-records";
import { LEGAL_LOGGER } from "./legal.tokens";

/**
 * A Prisma client or an open transaction. Acceptance is written inside the email-activation
 * transaction, so the writer has to work against either.
 */
type PrismaLike = Pick<PrismaService, "legalRecord">;

/**
 * Legal acceptance records and the request intake channels.
 *
 * Two responsibilities, both deliberately narrow.
 *
 * **Acceptance** is append-only evidence. Nothing here updates a row: `createMany` with
 * `skipDuplicates` plus the `(userId, documentKind, documentVersion)` unique index is the whole
 * idempotency story, so repeated or concurrent submissions for one version produce exactly one
 * row and the first one wins. There is no path that backfills a historical user as having
 * accepted, and no path that rewrites what somebody accepted.
 *
 * **Requests** are recorded and acknowledged, and nothing else. The service does not decide a
 * withdrawal, calculate a refund, erase data or move a plan — those rules are outstanding
 * (`docs/legal/owner-inputs-and-review.md` O7 and O2), and software that guessed them would be
 * making a statement about a legal outcome nobody reviewed.
 */
@Injectable()
export class LegalService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LEGAL_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  /** What this account has accepted, and whether the required version is still outstanding. */
  async acceptanceStatus(
    userId: string,
  ): Promise<LegalAcceptanceStatusResponse> {
    const records = await this.prisma.legalRecord.findMany({
      where: { userId },
      orderBy: { recordedAt: "asc" },
      select: {
        documentKind: true,
        documentVersion: true,
        documentHash: true,
        record: true,
        surface: true,
        recordedAt: true,
      },
    });

    return {
      requiredTermsVersion: REQUIRED_TERMS_VERSION,
      outstanding: !records.some(
        (row) =>
          row.documentKind === "TERMS" &&
          row.documentVersion === REQUIRED_TERMS_VERSION &&
          row.record === "ACCEPTED",
      ),
      records: records.map((row) => ({
        documentKind: row.documentKind,
        documentVersion: row.documentVersion,
        documentHash: row.documentHash,
        record: row.record,
        surface: row.surface,
        recordedAt: row.recordedAt.toISOString(),
      })),
    };
  }

  /**
   * Writes one acceptance, idempotently.
   *
   * `client` lets the email-activation path pass its open transaction, so the acceptance and the
   * password installation commit or roll back together: an activation can never succeed without
   * its acceptance, and a failed acceptance can never leave an activated account behind.
   */
  async recordAcceptance(
    input: { userId: string; surface: LegalAcceptanceSurface },
    client: PrismaLike = this.prisma,
  ): Promise<void> {
    const { count } = await client.legalRecord.createMany({
      data: acceptanceRows(input),
      skipDuplicates: true,
    });

    this.logger.info({
      event: "legal.acceptance.recorded",
      actorUserId: input.userId,
      surface: input.surface,
      termsVersion: REQUIRED_TERMS_VERSION,
      // Zero means a concurrent or repeated submission found the rows already there. That is the
      // idempotent outcome, not a failure, and it is worth being able to see in the logs.
      rowsWritten: count,
    });
  }

  /**
   * Which surface an acceptance submitted through `POST /legal/acceptance` was given on.
   *
   * Decided here from persisted state rather than taken from the request: the surface is
   * evidence, and evidence a caller can choose is not evidence. An account that has never
   * recorded anything and signs in only with Google is completing Google onboarding; anything
   * else is an existing account accepting a required version. `EMAIL_ACTIVATION` is never
   * reachable from this endpoint — only the activation transaction writes it.
   */
  async resolveSurface(userId: string): Promise<LegalAcceptanceSurface> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        passwordHash: true,
        oauthAccounts: { select: { id: true }, take: 1 },
        legalRecords: { select: { id: true }, take: 1 },
      },
    });

    const isNewGoogleAccount =
      user !== null &&
      user.legalRecords.length === 0 &&
      user.passwordHash === null &&
      user.oauthAccounts.length > 0;

    return isNewGoogleAccount ? "GOOGLE_ONBOARDING" : "EXISTING_ACCOUNT";
  }

  /**
   * Records a submitted request and returns its receipt.
   *
   * The receipt is the durable acknowledgment: a reference, the server's submission time and the
   * exact text submitted. It is deliberately an acknowledgment of **receipt** and says so
   * everywhere it is rendered — it is not a decision, not a refund, and not a deletion.
   *
   * Repeating a submission creates a second record with its own reference rather than being
   * silently merged. Nothing about a request moves money or deletes anything, so there is no
   * double-effect to protect against, and swallowing the second one would lose a request somebody
   * deliberately sent.
   */
  async submitRequest(
    userId: string,
    submission: LegalRequestSubmission,
  ): Promise<LegalRequestReceipt> {
    const created = await this.prisma.legalRequest.create({
      data: {
        userId,
        kind: submission.kind,
        details: submission.details,
        reference: newRequestReference(submission.kind),
      },
      select: {
        reference: true,
        kind: true,
        status: true,
        details: true,
        submittedAt: true,
      },
    });

    // The details are the person's own words and may be personal data, so the log records that a
    // request of a kind arrived and its reference, never its content.
    this.logger.info({
      event: "legal.request.received",
      actorUserId: userId,
      kind: created.kind,
      reference: created.reference,
    });

    return toReceipt(created);
  }

  /** This account's own requests, newest first, so a receipt can be found again. */
  async listRequests(userId: string): Promise<readonly LegalRequestReceipt[]> {
    const rows = await this.prisma.legalRequest.findMany({
      where: { userId },
      orderBy: { submittedAt: "desc" },
      select: {
        reference: true,
        kind: true,
        status: true,
        details: true,
        submittedAt: true,
      },
    });
    return rows.map(toReceipt);
  }
}

function toReceipt(row: {
  reference: string;
  kind: LegalRequestKind;
  status: "RECEIVED";
  details: string;
  submittedAt: Date;
}): LegalRequestReceipt {
  return {
    reference: row.reference,
    kind: row.kind,
    status: row.status,
    details: row.details,
    submittedAt: row.submittedAt.toISOString(),
  };
}

/**
 * A short, human-quotable reference.
 *
 * Random rather than sequential: a sequential reference would tell every customer how many
 * requests the operator has ever received, and would let one person's reference be guessed from
 * another's. Base32-ish alphabet with the characters people misread removed.
 */
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function newRequestReference(kind: LegalRequestKind): string {
  const prefix = kind === "PRIVACY_REQUEST" ? "PR" : kind.slice(0, 2);
  const bytes = randomBytes(10);
  let body = "";
  for (const byte of bytes) {
    body += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  return `${prefix}-${body.slice(0, 5)}-${body.slice(5, 10)}`;
}
