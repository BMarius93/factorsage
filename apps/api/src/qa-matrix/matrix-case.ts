import {
  QA_MATRIX_EXPECTED_COMBINATIONS,
  QA_MATRIX_EXPECTED_CONFIGS,
  QA_MATRIX_EXPECTED_LISTS,
  QA_MATRIX_EXPECTED_STRATEGIES,
  QA_MATRIX_NAME_PREFIX,
  qaMatrixCombinations,
  qaMatrixRunLabel,
  type QaMatrixCombination,
  type QaMatrixFixtures,
} from "@intrinsic/testing";

/**
 * One cell of the matrix, as the runner addresses it.
 *
 * The identity is `QA-MATRIX-Sxx-Lxx-Cxx` and nothing else: it is what the report is keyed by, what
 * `--case` accepts, and what a failure is reproduced from. The runner never invents a second
 * identifier for a combination, because two identities for one thing is how a "failing case" stops
 * being reproducible.
 *
 * `index` is the position in the canonical enumeration. It carries no meaning beyond order —
 * strategy, then list, then configuration — but it makes a partially completed sweep resumable at a
 * known point and a report sortable back into the sequence it executed in.
 */
export type QaMatrixCase = {
  readonly index: number;
  /** `QA-MATRIX-S04-L09-C06` */
  readonly label: string;
  /** `S04-L09-C06`; the short form a developer types. */
  readonly caseId: string;
  readonly strategyId: string;
  readonly listId: string;
  readonly configId: string;
  readonly combination: QaMatrixCombination;
};

const CASE_ID_PATTERN = /^S(\d{2})-L(\d{2})-C(\d{2})$/;

/** `S04-L09-C06` — the label without the reserved prefix. */
export function qaMatrixCaseId(
  strategyId: string,
  listId: string,
  configId: string,
): string {
  return `${strategyId}-${listId}-${configId}`;
}

/**
 * Parses `S03-L07-C04`, with or without the `QA-MATRIX-` prefix.
 *
 * Deliberately strict about the two-digit shape: `S3-L7-C4` would be a different string for the
 * same cell, and a reproduction command that is only sometimes the same string is not a
 * reproduction command.
 */
export function parseQaMatrixCaseId(value: string): {
  strategyId: string;
  listId: string;
  configId: string;
} | null {
  const trimmed = value.trim().toUpperCase();
  const bare = trimmed.startsWith(QA_MATRIX_NAME_PREFIX)
    ? trimmed.slice(QA_MATRIX_NAME_PREFIX.length)
    : trimmed;
  const match = CASE_ID_PATTERN.exec(bare);
  if (!match) {
    return null;
  }
  return {
    strategyId: `S${match[1] as string}`,
    listId: `L${match[2] as string}`,
    configId: `C${match[3] as string}`,
  };
}

/**
 * The complete matrix in canonical order.
 *
 * Enumeration is delegated to `qaMatrixCombinations` rather than re-derived, so the runner and the
 * fixture package can never disagree about what the thousand combinations are.
 */
export function qaMatrixCases(
  fixtures: QaMatrixFixtures,
): readonly QaMatrixCase[] {
  return qaMatrixCombinations(fixtures).map((combination, index) => ({
    index,
    label: combination.label,
    caseId: qaMatrixCaseId(
      combination.strategy.id,
      combination.list.id,
      combination.config.id,
    ),
    strategyId: combination.strategy.id,
    listId: combination.list.id,
    configId: combination.config.id,
    combination,
  }));
}

export class QaMatrixCaseSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaMatrixCaseSelectionError";
  }
}

/**
 * Narrows the matrix to an explicit selection, preserving canonical order.
 *
 * An unknown case is an error rather than an empty selection: `--case S03-L07-C99` almost always
 * means a typo, and silently running nothing would report a green sweep of zero cases.
 */
export function selectQaMatrixCases(
  cases: readonly QaMatrixCase[],
  selection: readonly string[],
): readonly QaMatrixCase[] {
  if (selection.length === 0) {
    return cases;
  }
  const byCaseId = new Map(cases.map((entry) => [entry.caseId, entry]));
  const wanted = new Set<string>();
  for (const raw of selection) {
    const parsed = parseQaMatrixCaseId(raw);
    if (!parsed) {
      throw new QaMatrixCaseSelectionError(
        `\`${raw}\` is not a matrix case identity. Expected Sxx-Lxx-Cxx, for example S03-L07-C04.`,
      );
    }
    const caseId = qaMatrixCaseId(
      parsed.strategyId,
      parsed.listId,
      parsed.configId,
    );
    if (!byCaseId.has(caseId)) {
      throw new QaMatrixCaseSelectionError(
        `\`${caseId}\` is not a combination of this matrix. Strategies are S01-S${String(
          QA_MATRIX_EXPECTED_STRATEGIES,
        ).padStart(2, "0")}, lists L01-L${String(QA_MATRIX_EXPECTED_LISTS).padStart(
          2,
          "0",
        )} and configurations C01-C${String(QA_MATRIX_EXPECTED_CONFIGS).padStart(2, "0")}.`,
      );
    }
    wanted.add(caseId);
  }
  return cases.filter((entry) => wanted.has(entry.caseId));
}

/**
 * The deterministic golden set: the combinations that are re-executed with forensic capture on.
 *
 * A full debug archive holds every evaluation frame the day loop consumed, which is the only
 * evidence that can answer "was this trade actually justified by the data the engine saw" — and
 * also, for a thirty-year thirty-security run, hundreds of megabytes. A thousand of them is not a
 * validation strategy, it is a disk-space incident, so archives are reserved for these and for
 * failures.
 *
 * Chosen to span what an archive can prove that persisted results cannot: signal evaluation against
 * real operand columns, Trigger `t-1` semantics across a year boundary, buy-window boundary
 * inclusion, a later-listing universe, and the contribution top-up path. Fixed rather than sampled,
 * because "the golden set" has to mean the same thing in two sweeps a week apart.
 */
export const QA_MATRIX_GOLDEN_CASES: readonly {
  readonly caseId: string;
  readonly reason: string;
}[] = [
  {
    caseId: "S01-L02-C04",
    reason:
      "One Condition over one year against three long-listed securities: the smallest archive in " +
      "which every trade can be re-derived by hand from the frame columns.",
  },
  {
    caseId: "S02-L01-C02",
    reason:
      "Trigger-only entry and exit on a single security across ten annual windows — the case that " +
      "proves the row retained across a year boundary is the one the `t-1` comparison used.",
  },
  {
    caseId: "S04-L05-C05",
    reason:
      "Nested BUY ladder with monthly contributions and mixed FULL/CUSTOM windows: strongest " +
      "eligible level, settled levels and contribution top-ups in one archive.",
  },
  {
    caseId: "S05-L10-C03",
    reason:
      "High turnover against windows that sit exactly on execution-date boundaries, including two " +
      "single-session windows: buy-window inclusion is decided per trade rather than per run.",
  },
  {
    caseId: "S07-L06-C01",
    reason:
      "Thirty years over a universe that lists entirely inside the horizon, with no SELL at all: " +
      "the archive that shows nothing traded before a security had data.",
  },
  {
    caseId: "S10-L08-C09",
    reason:
      "Thirty securities competing for one slot: same-date rotation, candidate ordering and the " +
      "forbidden same-date re-entry, all visible in one trade sequence.",
  },
];

/** The golden set as cases, in canonical order, failing loudly if one no longer exists. */
export function qaMatrixGoldenCases(
  cases: readonly QaMatrixCase[],
): readonly QaMatrixCase[] {
  return selectQaMatrixCases(
    cases,
    QA_MATRIX_GOLDEN_CASES.map((entry) => entry.caseId),
  );
}

/**
 * The expected size of the complete matrix.
 *
 * Re-exported from the fixture package rather than restated, so a runner that enumerated 999 cases
 * fails a comparison instead of quietly agreeing with itself.
 */
export const QA_MATRIX_TOTAL_CASES = QA_MATRIX_EXPECTED_COMBINATIONS;

export { qaMatrixRunLabel };

/**
 * The smallest set of combinations that makes every security's canonical data resident.
 *
 * Run before the timed sweep, at a concurrency of one. Its purpose is not measurement — its results
 * are discarded — but to move first-touch hydration out of the sweep it would otherwise distort.
 *
 * That distortion is not hypothetical. Against a freshly provisioned matrix database the Redis
 * projections are empty, so the first run to reach a security hydrates it: thirty-four years of
 * prices, derived state and statements, written year by year under a Redlock lease. With several
 * worker processes reaching overlapping universes at once, a lease can expire mid-hydration, a
 * second process legitimately takes over, and the first one's next write finds a manifest it no
 * longer owns — `Stock cache hydration generation changed`, which the worker reports as
 * `EXECUTION_FAILED` in `PREPARING_DATA`. A warm sweep never provokes it, and it is also three
 * times faster.
 *
 * The set is chosen by greedy cover over the lists rather than written down, so it follows the
 * fixtures instead of having to be maintained beside them: the longest configuration, so every
 * calendar-year chunk is warmed, and the first strategy, because the cached projections are whole
 * derived-state rows rather than per-operand columns.
 */
export function qaMatrixWarmupCases(
  cases: readonly QaMatrixCase[],
): readonly QaMatrixCase[] {
  const first = cases[0];
  if (!first) {
    return [];
  }
  const strategyId = first.strategyId;
  // The earliest-starting configuration covers every year chunk the other nine can ask for.
  const configId = [...cases]
    .sort((left, right) =>
      left.combination.config.request.startDate.localeCompare(
        right.combination.config.request.startDate,
      ),
    )[0]?.configId as string;

  const byList = new Map<string, QaMatrixCase>();
  for (const entry of cases) {
    if (entry.strategyId === strategyId && entry.configId === configId) {
      byList.set(entry.listId, entry);
    }
  }

  const remaining = new Set<string>();
  for (const entry of byList.values()) {
    for (const member of entry.combination.list.members) {
      remaining.add(member.symbol);
    }
  }

  const chosen: QaMatrixCase[] = [];
  const candidates = [...byList.values()];
  while (remaining.size > 0) {
    let best: { entry: QaMatrixCase; covers: number } | null = null;
    for (const entry of candidates) {
      if (chosen.includes(entry)) {
        continue;
      }
      const covers = entry.combination.list.members.filter((member) =>
        remaining.has(member.symbol),
      ).length;
      if (covers > 0 && (!best || covers > best.covers)) {
        best = { entry, covers };
      }
    }
    if (!best) {
      break;
    }
    chosen.push(best.entry);
    for (const member of best.entry.combination.list.members) {
      remaining.delete(member.symbol);
    }
  }
  return chosen.sort((left, right) => left.index - right.index);
}
