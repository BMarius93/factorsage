import {
  monitorActivityWindowStart,
  normalizeStrategyDefinition,
  strategyMetricSource,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { Prisma, type PrismaClient } from "@intrinsic/database";
import type { LocalDate, Security } from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import { addDays } from "@intrinsic/stock-data";
import {
  collectOperands,
  explainMonitorLevel,
  monitorStrategyLevels,
  type EvaluationFrame,
  type MonitorStrategyLevel,
  type MonitorTransitionEvidence,
} from "@intrinsic/strategy";
import type { MonitorEvaluationData } from "./monitor-evaluation.js";

/**
 * Legacy Monitor activity without evidence (`docs/decisions/monitor-eod-v2.md` §12.6).
 *
 * Transitions decided before evidence was recorded (§5.3) explain themselves by their rule's wording
 * alone (`RULE_ONLY`). The Dashboard never shows such an event: every condition it shows carries the
 * values that decided it. This reconstructs a legacy event's evidence **only** when it can be
 * verified from persisted canonical data, and otherwise leaves it out — it never invents a value and
 * never rewrites a date:
 *
 * 1. **An end-of-day occurrence.** An occurrence the earlier live-quote Monitor decided on an intraday
 *    price is never given end-of-day values: they are not what decided it (`LIVE_QUOTE`).
 * 2. **The exact logic.** The Strategy version recorded with the change — or, for older rows, with
 *    its occurrence — must hold the level, monitored, under the very fingerprint the change was
 *    decided on. A level reading an ETF or Stock's Sector is not reconstructed: whether the fund's
 *    session was available when it was decided is not recorded, so its values could not be verified.
 * 3. **The same data.** The session is read from the stored, finalized bars and materialized series
 *    through the evaluation's own frame (`readFinalizedEvaluationFrame`, PostgreSQL only), and the
 *    occurrence's recorded activation price must be that session's stored close.
 * 4. **The same decision.** The canonical `explainMonitorLevel` — the function the evaluation records
 *    evidence with — must reproduce the recorded change: every predicate of the deciding rule held
 *    for an activation, a Condition did not hold for an ending.
 *
 * A verified event's evidence is written once (`evidence IS NULL` guards it, so a rerun or a second
 * process changes nothing), with a `reconstructed` stamp naming when and by what, so it is never
 * mistaken for evidence recorded when the session was decided. Nothing else on the row moves: its
 * session, its processing time, its origin and its version stay what they were.
 */

export const LEGACY_EVIDENCE_OUTCOMES = [
  "RECONSTRUCTED",
  "EXCLUDED_LIVE_QUOTE",
  "EXCLUDED_NO_OCCURRENCE",
  "EXCLUDED_VERSION_UNREADABLE",
  "EXCLUDED_LOGIC_MISMATCH",
  "EXCLUDED_ETF_DEPENDENCY",
  "EXCLUDED_SESSION_MISSING",
  "EXCLUDED_PRICE_MISMATCH",
  "EXCLUDED_DECISION_MISMATCH",
  "EXCLUDED_READ_FAILED",
] as const;
export type LegacyEvidenceOutcome = (typeof LEGACY_EVIDENCE_OUTCOMES)[number];

/** The evidence written for a verified legacy event: version 1, stamped as reconstructed. */
export type ReconstructedTransitionEvidence = MonitorTransitionEvidence & {
  reconstructed: { at: string; by: "monitors:backfill-evidence" };
};

/** One legacy event, as the verification needs it. */
export type LegacyEventCandidate = {
  transitionId: string;
  levelId: string;
  signalFingerprint: string;
  exitRuleId: string | null;
  toState: "INACTIVE" | "PENDING_TRIGGER" | "ACTIVE" | "RESOLVED";
  reason: string;
  /** The session the change was decided on. */
  session: LocalDate;
  occurrence: {
    observationBasis: "LIVE_QUOTE" | "EOD_CLOSE";
    activatedOn: LocalDate;
    activationPrice: number;
  } | null;
};

/** What a candidate's logic is, once its version has been read. */
export type LegacyLogic =
  | { kind: "UNREADABLE" }
  | { kind: "LEVEL"; level: MonitorStrategyLevel };

/** The relative tolerance a stored close is compared with the recorded activation price at. */
const PRICE_TOLERANCE = 1e-9;

/**
 * Decides one candidate: its verified evidence, or why it is left out. Pure — the frame is the
 * security's stored sessions, read by the caller.
 */
export function verifyLegacyEvent(
  candidate: LegacyEventCandidate,
  logic: LegacyLogic,
  frame: EvaluationFrame | null,
): { outcome: LegacyEvidenceOutcome; evidence?: MonitorTransitionEvidence } {
  if (!candidate.occurrence) {
    return { outcome: "EXCLUDED_NO_OCCURRENCE" };
  }
  if (candidate.occurrence.observationBasis !== "EOD_CLOSE") {
    return { outcome: "EXCLUDED_LIVE_QUOTE" };
  }
  if (logic.kind === "UNREADABLE") {
    return { outcome: "EXCLUDED_VERSION_UNREADABLE" };
  }
  const { level } = logic;
  if (level.fingerprint !== candidate.signalFingerprint) {
    return { outcome: "EXCLUDED_LOGIC_MISMATCH" };
  }
  if (readsAFund(level)) {
    return { outcome: "EXCLUDED_ETF_DEPENDENCY" };
  }
  if (frame === null) {
    return { outcome: "EXCLUDED_READ_FAILED" };
  }
  const index = frame.dates.indexOf(candidate.session);
  if (index < 0) {
    return { outcome: "EXCLUDED_SESSION_MISSING" };
  }
  const activationIndex = frame.dates.indexOf(
    candidate.occurrence.activatedOn,
  );
  if (activationIndex < 0) {
    return { outcome: "EXCLUDED_SESSION_MISSING" };
  }
  const close = frame.closes[activationIndex]!;
  const recorded = candidate.occurrence.activationPrice;
  if (
    !Number.isFinite(close) ||
    Math.abs(close - recorded) > PRICE_TOLERANCE * Math.max(1, Math.abs(recorded))
  ) {
    return { outcome: "EXCLUDED_PRICE_MISMATCH" };
  }
  const evidence = explainMonitorLevel(
    level,
    frame,
    index,
    candidate.exitRuleId,
  );
  return decisionReproduced(candidate, evidence)
    ? { outcome: "RECONSTRUCTED", evidence }
    : { outcome: "EXCLUDED_DECISION_MISMATCH" };
}

/**
 * Whether the evidence decides the recorded change: an activation needs some rule — the one named,
 * when one is — whose every predicate held; an ending needs a Condition of the deciding rule that
 * did not hold. A predicate that could not be decided never decided anything.
 */
function decisionReproduced(
  candidate: LegacyEventCandidate,
  evidence: MonitorTransitionEvidence,
): boolean {
  if (evidence.rules.length === 0) {
    return false;
  }
  if (candidate.toState === "ACTIVE") {
    return evidence.rules.some(
      (rule) =>
        rule.predicates.length > 0 &&
        rule.predicates.every((predicate) => predicate.result === "TRUE") &&
        (candidate.reason !== "TRIGGER_FIRED" ||
          rule.predicates.some((predicate) => predicate.role === "TRIGGER")),
    );
  }
  return evidence.rules.every((rule) =>
    rule.predicates.some(
      (predicate) =>
        predicate.role === "CONDITION" && predicate.result === "FALSE",
    ),
  );
}

function readsAFund(level: MonitorStrategyLevel): boolean {
  return level.rules.some((signal) =>
    [...signal.conditions, ...(signal.trigger ? [signal.trigger] : [])].some(
      (predicate) => {
        const source = strategyMetricSource(predicate.metric);
        return source?.kind === "ETF" || source?.kind === "STOCK_SECTOR";
      },
    ),
  );
}

export type LegacyEvidenceReport = {
  windowStart: LocalDate;
  apply: boolean;
  candidates: number;
  outcomes: Record<LegacyEvidenceOutcome, number>;
  /** Evidence written by this run (0 on a dry run, or for rows another process wrote first). */
  written: number;
};

/**
 * `pnpm monitors:backfill-evidence`: verifies every legacy event inside the Dashboard's rolling
 * window, and with `apply` records the evidence of each verified one. Reads PostgreSQL only, never a
 * provider; reports how many events were recoverable and how many stay excluded, and why.
 */
export class LegacyEvidenceBackfill {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly data: Pick<
      MonitorEvaluationData,
      "findSecurities" | "readFinalizedEvaluationFrame"
    >,
    private readonly logger: StructuredLogger,
    private readonly options: {
      /** The newest finalized date: the window ends here. */
      latest: LocalDate;
      apply: boolean;
      now: () => Date;
    },
  ) {}

  async run(): Promise<LegacyEvidenceReport> {
    const startedAt = Date.now();
    const windowStart = monitorActivityWindowStart(this.options.latest);
    const report: LegacyEvidenceReport = {
      windowStart,
      apply: this.options.apply,
      candidates: 0,
      outcomes: Object.fromEntries(
        LEGACY_EVIDENCE_OUTCOMES.map((outcome) => [outcome, 0]),
      ) as Record<LegacyEvidenceOutcome, number>,
      written: 0,
    };
    this.logger.info({
      event: "monitor.legacy-evidence.started",
      windowStart,
      apply: this.options.apply,
    });

    const rows = await this.prisma.monitorStateTransition.findMany({
      where: {
        evidence: { equals: Prisma.DbNull },
        origin: { in: ["OBSERVED", "HISTORY"] },
        observationDate: { gte: new Date(`${windowStart}T00:00:00.000Z`) },
        OR: [
          { toState: "ACTIVE", reason: { in: ["CONDITIONS_MET", "TRIGGER_FIRED"] } },
          { fromState: "ACTIVE", toState: { not: "ACTIVE" }, reason: "CONDITIONS_ENDED" },
        ],
      },
      select: {
        id: true,
        securityId: true,
        levelId: true,
        signalFingerprint: true,
        exitRuleId: true,
        toState: true,
        reason: true,
        observationDate: true,
        strategyVersionId: true,
        signal: {
          select: {
            strategyVersionId: true,
            observationBasis: true,
            observationDate: true,
            observationPrice: true,
          },
        },
      },
      orderBy: [{ securityId: "asc" }, { sequence: "asc" }],
    });
    report.candidates = rows.length;
    if (rows.length === 0) {
      this.finish(report, startedAt);
      return report;
    }

    // Every version any candidate names, read once.
    const versionIds = [
      ...new Set(
        rows.flatMap((row) => {
          const id = row.strategyVersionId ?? row.signal?.strategyVersionId;
          return id ? [id] : [];
        }),
      ),
    ];
    const definitions = new Map<string, StrategyDefinition | null>();
    for (const version of await this.prisma.strategyVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, definition: true },
    })) {
      try {
        definitions.set(version.id, normalizeStrategyDefinition(version.definition));
      } catch {
        definitions.set(version.id, null);
      }
    }

    const bySecurity = new Map<string, typeof rows>();
    for (const row of rows) {
      const bucket = bySecurity.get(row.securityId);
      if (bucket) {
        bucket.push(row);
      } else {
        bySecurity.set(row.securityId, [row]);
      }
    }
    const securities = new Map(
      (await this.data.findSecurities([...bySecurity.keys()])).map(
        (security) => [security.id, security] as const,
      ),
    );

    for (const [securityId, events] of bySecurity) {
      const candidates = events.map((row) => ({
        row,
        candidate: candidateOf(row),
        definition: (() => {
          const id = row.strategyVersionId ?? row.signal?.strategyVersionId;
          return id ? (definitions.get(id) ?? null) : null;
        })(),
      }));
      const frame = await this.readFrame(
        securities.get(securityId),
        candidates.map((entry) => entry.candidate),
        candidates.flatMap((entry) => (entry.definition ? [entry.definition] : [])),
      );
      for (const { row, candidate, definition } of candidates) {
        const level = definition
          ? monitorStrategyLevels(definition).find((entry) => entry.id === row.levelId)
          : undefined;
        const decided = verifyLegacyEvent(
          candidate,
          level ? { kind: "LEVEL", level } : { kind: "UNREADABLE" },
          frame,
        );
        report.outcomes[decided.outcome] += 1;
        this.logger.debug({
          event: "monitor.legacy-evidence.decided",
          transitionId: row.id,
          outcome: decided.outcome,
        });
        if (decided.outcome !== "RECONSTRUCTED" || !this.options.apply) {
          continue;
        }
        const stamped: ReconstructedTransitionEvidence = {
          ...decided.evidence!,
          reconstructed: {
            at: this.options.now().toISOString(),
            by: "monitors:backfill-evidence",
          },
        };
        const written = await this.prisma.monitorStateTransition.updateMany({
          where: { id: row.id, evidence: { equals: Prisma.DbNull } },
          data: { evidence: stamped as unknown as Prisma.InputJsonValue },
        });
        report.written += written.count;
      }
    }
    this.finish(report, startedAt);
    return report;
  }

  /** One frame per security, over every session its candidates need, from PostgreSQL alone. */
  private async readFrame(
    security: Security | undefined,
    candidates: readonly LegacyEventCandidate[],
    definitions: readonly StrategyDefinition[],
  ): Promise<EvaluationFrame | null> {
    if (!security) {
      return null;
    }
    const dates = candidates.flatMap((candidate) => [
      candidate.session,
      ...(candidate.occurrence ? [candidate.occurrence.activatedOn] : []),
    ]);
    const from = dates.reduce((oldest, date) => (date < oldest ? date : oldest));
    const to = dates.reduce((newest, date) => (date > newest ? date : newest));
    const operands = [
      ...new Set(definitions.flatMap((definition) => collectOperands(definition))),
    ].sort();
    try {
      // A few sessions earlier than the oldest date, so a Trigger's previous session is in it.
      return (
        await this.data.readFinalizedEvaluationFrame(
          security,
          { from: addDays(from, -14), to },
          operands,
        )
      ).frame;
    } catch (err) {
      this.logger.warn({
        event: "monitor.legacy-evidence.read-failed",
        symbol: security.symbol,
        err,
      });
      return null;
    }
  }

  private finish(report: LegacyEvidenceReport, startedAt: number): void {
    this.logger.info({
      event: "monitor.legacy-evidence.completed",
      durationMs: Date.now() - startedAt,
      windowStart: report.windowStart,
      apply: report.apply,
      candidates: report.candidates,
      recoverable: report.outcomes.RECONSTRUCTED,
      excluded: report.candidates - report.outcomes.RECONSTRUCTED,
      written: report.written,
      outcomes: report.outcomes,
    });
  }
}

function candidateOf(row: {
  id: string;
  levelId: string;
  signalFingerprint: string;
  exitRuleId: string | null;
  toState: LegacyEventCandidate["toState"];
  reason: string;
  observationDate: Date | null;
  signal: {
    observationBasis: "LIVE_QUOTE" | "EOD_CLOSE";
    observationDate: Date;
    observationPrice: Prisma.Decimal;
  } | null;
}): LegacyEventCandidate {
  return {
    transitionId: row.id,
    levelId: row.levelId,
    signalFingerprint: row.signalFingerprint,
    exitRuleId: row.exitRuleId,
    toState: row.toState,
    reason: row.reason,
    session: row.observationDate!.toISOString().slice(0, 10),
    occurrence: row.signal
      ? {
          observationBasis: row.signal.observationBasis,
          activatedOn: row.signal.observationDate.toISOString().slice(0, 10),
          activationPrice: Number(row.signal.observationPrice),
        }
      : null,
  };
}
