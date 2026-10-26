/**
 * Deterministic English descriptions of canonical definitions.
 *
 * Generated from the document alone — no model, no network, no clock, no locale — and composed from
 * the platform's own canonical sentences: every rule reads exactly as the Strategy Builder's logic
 * preview, a trade reason and the Dashboard print it (`describeCondition`, `describeTrigger`), with
 * the catalog's labels and the product's units. Nothing is inferred beyond what the document says,
 * and nothing claims performance. A List's description never names a security; a Strategy's never
 * names the Strategy.
 */

import {
  describeCondition,
  describeTrigger,
  IS_CLOSE_TO_TOLERANCE,
  STRATEGY_LEVEL_PERCENTAGE_BASIS,
  strategyMetricSource,
  type StrategyCondition,
  type StrategyScopeNames,
  type StrategySignal,
  type StrategyTrigger,
} from "@intrinsic/contracts";
import {
  pointInTimeIndexUniverse,
  type MarketIndexKey,
} from "@intrinsic/domain";
import { CanonicalDefinitionError } from "./issues.js";
import { strategyDefinitionOf } from "./strategy-codec.js";
import type {
  CanonicalDefinitionDocument,
  CanonicalIndexMembership,
  CanonicalListDocument,
  CanonicalMemberList,
  CanonicalStrategyDocument,
  DefinitionDescription,
} from "./types.js";
import { validateDefinition } from "./validate.js";

/** How many rules of one Signal the short description names before it counts the rest. */
const SHORT_RULE_LIMIT = 2;

/**
 * The short and the detailed description of a canonical document.
 *
 * Validates first, so a description can only ever be of a definition this build would accept;
 * throws {@link CanonicalDefinitionError} otherwise. The same document always yields the same text.
 */
export function describeDefinition(input: unknown): DefinitionDescription {
  const result = validateDefinition(input);
  if (!result.valid) {
    throw new CanonicalDefinitionError(result.issues);
  }
  return describeValidDefinition(result.document);
}

function describeValidDefinition(
  document: CanonicalDefinitionDocument,
): DefinitionDescription {
  return document.type === "strategy"
    ? describeStrategyDocument(document)
    : describeListDocument(document);
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

function describeStrategyDocument(
  document: CanonicalStrategyDocument,
): DefinitionDescription {
  // Rebuilt with the bioguide ids as actor ids, which is what the names below are keyed by.
  const definition = strategyDefinitionOf(document.definition);
  const names: StrategyScopeNames = {
    actors: Object.fromEntries(
      (document.actors ?? []).map((actor) => [actor.id, actor.name]),
    ),
  };
  const predicates = (signal: StrategySignal): string[] => [
    ...signal.conditions.map((condition) =>
      describeCondition(condition, names),
    ),
    ...(signal.trigger ? [describeTrigger(signal.trigger, names)] : []),
  ];
  const signalText = (signal: StrategySignal, limit?: number): string =>
    joinRules(predicates(signal), signal.trigger !== undefined, limit);

  const buyLevels = definition.buyLevels;
  const sellLevels = definition.sellLevels;
  const finalExit = definition.finalExit;

  // --- short ---------------------------------------------------------------
  const first = buyLevels[0];
  const entry =
    first === undefined
      ? "Has no buy level."
      : buyLevels.length === 1
        ? `Buys when ${signalText(first.signal, SHORT_RULE_LIMIT)}.`
        : `Buys in ${buyLevels.length} levels, the first when ${signalText(first.signal, SHORT_RULE_LIMIT)}.`;
  const exits: string[] = [];
  if (sellLevels.length > 0) {
    exits.push(`sells in ${count(sellLevels.length, "level")}`);
  }
  if (finalExit) {
    const onlyRule =
      finalExit.rules.length === 1 ? finalExit.rules[0] : undefined;
    exits.push(
      onlyRule
        ? `closes the position when ${signalText(onlyRule.signal, SHORT_RULE_LIMIT)}`
        : `closes the position when any of ${finalExit.rules.length} exit rules matches`,
    );
  }
  const exit =
    exits.length === 0
      ? "It has no sell level and no final exit."
      : `${capitalize(exits.join(" and "))}.`;
  const short = `${entry} ${exit}`;

  // --- detailed ------------------------------------------------------------
  const lines: string[] = [];
  buyLevels.forEach((level, index) => {
    lines.push(
      `${levelName("BUY", index, buyLevels.length)}: buys ${level.percentage}% ${STRATEGY_LEVEL_PERCENTAGE_BASIS.BUY} when ${signalText(level.signal)}.`,
    );
  });
  sellLevels.forEach((level, index) => {
    lines.push(
      `${levelName("SELL", index, sellLevels.length)}: sells ${level.percentage}% ${STRATEGY_LEVEL_PERCENTAGE_BASIS.SELL} when ${signalText(level.signal)}.`,
    );
  });
  if (finalExit) {
    const rules = finalExit.rules;
    const onlyRule = rules.length === 1 ? rules[0] : undefined;
    lines.push(
      onlyRule
        ? `FINAL EXIT: closes the whole remaining position when ${signalText(onlyRule.signal)}.`
        : `FINAL EXIT: closes the whole remaining position when any one of ${rules.length} exit rules matches — ${rules
            .map((rule, index) => `(${index + 1}) ${signalText(rule.signal)}`)
            .join("; ")}.`,
    );
  } else if (sellLevels.length === 0) {
    lines.push("There is no sell level and no final exit.");
  }
  lines.push(
    strategyNotes(
      definition.buyLevels
        .map((level) => level.signal)
        .concat(definition.sellLevels.map((level) => level.signal))
        .concat((definition.finalExit?.rules ?? []).map((rule) => rule.signal)),
    ),
  );

  return { short, detailed: lines.join("\n") };
}

function levelName(kind: "BUY" | "SELL", index: number, total: number): string {
  return total === 1 ? kind : `${kind} level ${index + 1}`;
}

/**
 * The rules of one Signal joined by "and". With a limit, the first `limit` are named and the rest
 * counted, so a long Signal still reads as one short clause.
 */
function joinRules(
  rules: readonly string[],
  hasTrigger: boolean,
  limit?: number,
): string {
  if (limit === undefined || rules.length <= limit + 1) {
    return rules.join(" and ");
  }
  const named = rules.slice(0, limit);
  const remainingConditions = rules.length - limit - (hasTrigger ? 1 : 0);
  const remainder: string[] = [];
  if (remainingConditions > 0) {
    remainder.push(
      `${remainingConditions} more ${remainingConditions === 1 ? "condition" : "conditions"}`,
    );
  }
  if (hasTrigger) {
    remainder.push("a trigger");
  }
  return `${named.join(" and ")}, plus ${remainder.join(" and ")}`;
}

/** What a reader needs to read the rules correctly, stated only where the rules use it. */
function strategyNotes(signals: readonly StrategySignal[]): string {
  const predicates: (StrategyCondition | StrategyTrigger)[] = signals.flatMap(
    (signal) => [
      ...signal.conditions,
      ...(signal.trigger ? [signal.trigger] : []),
    ],
  );
  const hasTrigger = signals.some((signal) => signal.trigger !== undefined);
  const notes: string[] = [
    hasTrigger
      ? "Within a level, every condition must hold on the same session; where a level has a trigger, it must fire on that session too."
      : "Within a level, every condition must hold on the same session.",
  ];
  if (predicates.some((predicate) => predicate.operator === "IS_CLOSE_TO")) {
    notes.push(
      `"is close to" means within ${IS_CLOSE_TO_TOLERANCE * 100}% of the value.`,
    );
  }
  const sources = predicates.map((predicate) =>
    strategyMetricSource(predicate.metric),
  );
  if (sources.some((source) => source?.kind === "ETF")) {
    notes.push(
      "A rule that names an ETF reads that ETF's own history, not the stock's.",
    );
  }
  if (sources.some((source) => source?.kind === "STOCK_SECTOR")) {
    notes.push(
      `A "Stock's Sector" rule reads the sector ETF of each stock it evaluates.`,
    );
  }
  if (
    predicates.some(
      (predicate) =>
        predicate.metric.kind === "GAIN" || predicate.metric.kind === "LOSS",
    )
  ) {
    notes.push("Gain and Loss are measured on the open position.");
  }
  notes.push("Rules are evaluated on finalized end-of-day data.");
  return notes.join(" ");
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function describeListDocument(
  document: CanonicalListDocument,
): DefinitionDescription {
  const membership = document.definition.membership;
  return membership.kind === "members"
    ? describeMembers(membership)
    : describeIndexMembership(membership);
}

function describeMembers(
  membership: CanonicalMemberList,
): DefinitionDescription {
  const members = membership.members;
  const total = members.length;
  if (total === 0) {
    return {
      short: "An empty list.",
      detailed: "The list holds no securities.",
    };
  }
  let always = 0;
  let windows = 0;
  let open = 0;
  let earliest: string | undefined;
  for (const member of members) {
    if (member.buyWindow.mode === "FULL") {
      always += 1;
      continue;
    }
    windows += member.buyWindow.ranges.length;
    const firstRange = member.buyWindow.ranges[0];
    const lastRange =
      member.buyWindow.ranges[member.buyWindow.ranges.length - 1];
    if (
      firstRange &&
      (earliest === undefined || firstRange.startDate < earliest)
    ) {
      earliest = firstRange.startDate;
    }
    if (lastRange?.endDate === null) {
      open += 1;
    }
  }
  const limited = total - always;
  const securities = count(total, "security", "securities");

  const short =
    limited === 0
      ? `${securities}, each eligible to buy on any date.`
      : always === 0
        ? `${securities}, each eligible to buy only during its membership periods.`
        : `${securities}: ${formatCount(always)} eligible to buy on any date, ${formatCount(limited)} only during their membership periods.`;

  const sentences = [`A list of ${securities}.`];
  if (always > 0) {
    sentences.push(
      limited === 0
        ? "Every one may be bought on any date."
        : `${formatCount(always)} may be bought on any date.`,
    );
  }
  if (limited > 0) {
    const subject = always === 0 ? "Every one" : formatCount(limited);
    const owner = always === 0 || limited === 1 ? "its" : "their";
    const openText =
      open === 0
        ? ""
        : `; ${formatCount(open)} ${open === 1 ? "is" : "are"} still open-ended`;
    sentences.push(
      `${subject} may be bought only inside ${owner} membership periods: ${count(windows, "period")} in total, the earliest starting ${formatDate(earliest as string)}${openText}.`,
    );
    sentences.push(
      "Membership limits new buys only: a holding is not sold when its membership period ends.",
    );
  }
  return { short, detailed: sentences.join(" ") };
}

function describeIndexMembership(
  membership: CanonicalIndexMembership,
): DefinitionDescription {
  const universe = pointInTimeIndexUniverse(membership.index as MarketIndexKey);
  const pinned = membership.membership;
  const index = universe.indexName;
  const short = `Uses historical ${index} membership to determine eligible securities at each point in time.`;
  const scope = membership.period
    ? `Between ${formatDate(membership.period.startDate)} and ${formatDate(membership.period.endDate)}, the pinned membership holds ${count(pinned.securities, "security", "securities")} that were index members at some point, at most ${formatCount(pinned.peakSimultaneousMembers)} at the same time, across ${count(pinned.windows, "membership period")}.`
    : `Since ${formatDate(membership.membershipFloor)}, the pinned membership holds ${count(pinned.securities, "security", "securities")} across ${count(pinned.windows, "membership period")}, at most ${formatCount(pinned.peakSimultaneousMembers)} at the same time.`;
  const detailed = [
    `Uses the point-in-time membership of the ${index}: a security is eligible to buy only on dates it was an index member, so the universe follows the index's actual history rather than today's constituents.`,
    scope,
    "Former constituents without price history cannot be traded and are never substituted.",
    "Membership limits new buys only: a holding is not sold when its company leaves the index.",
    "The membership is pinned, so later corrections to the index history do not change it.",
  ].join(" ");
  return { short, detailed };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `2010-01-04` → `Jan 4, 2010`, from the string alone: no time zone, no locale. */
function formatDate(date: string): string {
  const [year, month, day] = date.split("-");
  const name = MONTHS[Number(month) - 1];
  return `${name} ${Number(day)}, ${year}`;
}

/** A whole number with thousands separators, written out without a locale. */
function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function count(
  value: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}
