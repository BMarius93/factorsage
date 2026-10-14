"use client";

import {
  STRATEGY_ETF_SOURCE_GROUPS,
  STRATEGY_ETF_SOURCES,
  findStrategyEtfSource,
  isStrategyEtfSourceCode,
  strategyEtfSourcesOffered,
  strategyMetricCategory,
  strategyMetricFamilies,
  strategyMetricFamily,
  strategyMetricKey,
  strategyMetricLabel,
  strategyMetricOptions,
  strategyMetricSource,
  strategyMetricSourceKey,
  strategyMetricUnderSource,
  FMP_STOCK_SECTORS,
  STOCK_SECTOR_ETF_CODES,
  STOCK_SECTOR_SOURCE_LABEL,
  stockSectorEtfTicker,
  type StrategyEtfSourceCode,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategyMetricCategory,
  type StrategyMetricCategoryId,
  type StrategyMetricFamilyId,
  type StrategyMetricSource,
  type StrategyPredicatePart,
} from "@intrinsic/contracts";
import { useId, useState, type KeyboardEvent } from "react";
import { Select } from "../../../components/ui/Select";
import { PickerPopover } from "./PickerPopover";
import operand from "./OperandPicker.module.css";
import styles from "./MetricPicker.module.css";

type MetricPickerProps = {
  readonly levelKind: StrategyLevelKind;
  /** Which half of the Signal this row is: the registry decides what each may offer. */
  readonly part: StrategyPredicatePart;
  readonly metric: StrategyMetric;
  readonly label: string;
  readonly invalid: boolean;
  readonly describedBy?: string;
  /**
   * What the row's last change of metric or data source replaced, in words. Printed inside the open
   * picker as well as under the row, because a change of data source is made with the picker open
   * and the row's own line sits behind it.
   */
  readonly notice?: string | null;
  readonly onChange: (metric: StrategyMetric) => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
};

/**
 * What Stock's Sector reads, said where the ETF select would be: the first three mappings of the
 * canonical table as examples, so the sentence can never name a fund the mapping does not.
 */
const SECTOR_NOTE = `Each stock reads the sector ETF of its own FMP sector — ${FMP_STOCK_SECTORS.slice(
  0,
  3,
)
  .map(
    (sector) =>
      `${sector} reads ${stockSectorEtfTicker(STOCK_SECTOR_ETF_CODES[sector])}`,
  )
  .join(", ")}. A stock without one of the eleven sectors cannot be evaluated.`;

/** The ETF a rule moves to when it first leaves the stock: the catalog's first. */
const FIRST_ETF_CODE = STRATEGY_ETF_SOURCES[0]?.code;

/**
 * Moves focus among a container's items with the arrow keys, Home and End.
 *
 * Every item stays an ordinary button in the Tab order — the arrows are a faster path through a
 * list, never the only one — so nothing about the list needs a composite role to be reachable.
 */
function moveFocus(
  event: KeyboardEvent<HTMLElement>,
  items: readonly HTMLElement[],
  step: (index: number) => number | null,
): void {
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = step(index);
  if (next === null || next === index) {
    return;
  }
  const target = items[Math.max(0, Math.min(items.length - 1, next))];
  if (target) {
    event.preventDefault();
    target.focus();
  }
}

/** How many columns a rendered option grid has: the stylesheet decides, and this only reads it. */
function gridColumns(grid: Element | null | undefined): number {
  if (!(grid instanceof HTMLElement)) {
    return 1;
  }
  return Math.max(
    1,
    getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean)
      .length,
  );
}

/**
 * The Metric control: which data source the rule reads, and which metric of it, in one popover.
 *
 * The row keeps its three controls — Metric, Condition, Value — and everything about *what* is
 * measured lives behind the first (`docs/decisions/strategy-etf-conditions-v1.md` §4):
 *
 * 1. **Data source.** `Stock` — the evaluated security itself, the default — `ETF`, with one of
 *    the twenty Dashboard funds chosen from the product's own grouped select, or `Stock's Sector`,
 *    which chooses no fund: each evaluated stock reads the sector ETF its own FMP sector maps to.
 *    Both are Condition capabilities only, so a Trigger row shows them disabled and says why.
 * 2. **Metric library.** The registry's families for that source, level kind and half of a Signal —
 *    Technical, Fundamentals, Valuation, Activity, Position — as tabs. A family with several
 *    categories lists them as expandable subgroups, one open at a time, so `Price` is one compact
 *    row and a long family scrolls inside the list rather than stretching the popover. An ETF offers
 *    Technical alone: its 21 metrics are the registry's own technical instances.
 *
 * Choosing a metric is the edit, and closes the popover. Changing the data source keeps the rule's
 * metric wherever the new source offers the same identity — `RSI 14D` becomes `XLK · RSI 14D`, and
 * `XLK` becomes `XLF` — and that is an edit too, made at once. Where the new source cannot offer it
 * (a Fundamental has no ETF form) nothing changes until a metric is chosen, and the popover says so.
 *
 * Every option, family, subgroup, ETF and label is the registry's: nothing here lists a metric or a
 * fund, and no rule about what may be combined is decided in this component.
 */
export function MetricPicker({
  levelKind,
  part,
  metric,
  label,
  invalid,
  describedBy,
  notice,
  onChange,
  onFocus,
  onBlur,
}: MetricPickerProps) {
  const baseId = useId();
  const committedSource = strategyMetricSource(metric);
  const etfOffered = strategyEtfSourcesOffered(levelKind, part);
  const selectedKey = strategyMetricKey(metric);
  const homeFamilyId = strategyMetricFamily(metric);
  const homeCategoryId = strategyMetricCategory(metric);

  // What the open popover is showing. All of it is reset as the popover opens, so every opening
  // starts on the rule's own source, family and subgroup rather than where the last browse was left.
  const [browseSource, setBrowseSource] = useState<
    StrategyMetricSource | undefined
  >(committedSource);
  const [etfCode, setEtfCode] = useState<StrategyEtfSourceCode | undefined>(
    committedSource?.kind === "ETF" ? committedSource.code : FIRST_ETF_CODE,
  );
  const [familyId, setFamilyId] = useState<StrategyMetricFamilyId | null>(null);
  // `undefined`: nothing chosen yet, so the subgroup holding the rule's metric — or the family's
  // first — is the open one. `null`: the user closed them all.
  const [expandedId, setExpandedId] = useState<
    StrategyMetricCategoryId | null | undefined
  >(undefined);
  // Whether this opening has moved the rule to another data source: the one edit made with the
  // popover still open, and therefore the one whose outcome has to be readable inside it.
  const [movedSource, setMovedSource] = useState(false);

  const shownSource = etfOffered ? browseSource : undefined;
  const families = strategyMetricFamilies(levelKind, part, shownSource);
  const family =
    families.find((candidate) => candidate.id === familyId) ??
    families.find((candidate) => candidate.id === homeFamilyId) ??
    families[0];
  const grouped = (family?.categories.length ?? 0) > 1;
  const expanded =
    expandedId === undefined
      ? (family?.categories.find((category) => category.id === homeCategoryId)
          ?.id ?? family?.categories[0]?.id)
      : expandedId;
  // Browsing a source the rule does not read: only possible where that source cannot offer the
  // rule's metric, since a source that can is committed the moment it is chosen.
  const pending =
    strategyMetricSourceKey(shownSource) !==
    strategyMetricSourceKey(committedSource);

  // A saved strategy can carry a metric this level no longer offers — `Gain` in a BUY level after a
  // product change. It reads as unavailable instead of silently showing another metric; validation
  // is what reports it and names the metric.
  const offered = strategyMetricOptions(levelKind, part, committedSource).some(
    (option) => strategyMetricKey(option.metric) === selectedKey,
  );
  const shownEtf =
    shownSource?.kind === "ETF"
      ? findStrategyEtfSource(shownSource.code)
      : undefined;
  const sectorShown = shownSource?.kind === "STOCK_SECTOR";

  /**
   * Shows another data source, and moves the rule to it at once when it offers the rule's metric.
   * The metric's identity is what is kept; whether its operator and Value survive is the draft's
   * question, answered — and reported — as for any change of metric.
   */
  const showSource = (next: StrategyMetricSource | undefined) => {
    setBrowseSource(next);
    setFamilyId(null);
    setExpandedId(undefined);
    const kept = strategyMetricUnderSource(levelKind, part, metric, next);
    if (kept && strategyMetricKey(kept) !== selectedKey) {
      setMovedSource(true);
      onChange(kept);
    }
  };

  const tabId = (id: StrategyMetricFamilyId) => `${baseId}-family-${id}`;
  const libraryId = `${baseId}-library`;
  const optionsId = (id: StrategyMetricCategoryId) => `${baseId}-options-${id}`;
  const headerId = (id: StrategyMetricCategoryId) => `${baseId}-header-${id}`;

  const onFamilyKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [
      ...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
    ];
    const last = tabs.length - 1;
    const step =
      event.key === "ArrowRight"
        ? (index: number) => (index >= last ? 0 : index + 1)
        : event.key === "ArrowLeft"
          ? (index: number) => (index <= 0 ? last : index - 1)
          : event.key === "Home"
            ? () => 0
            : event.key === "End"
              ? () => last
              : null;
    if (!step) {
      return;
    }
    moveFocus(event, tabs, step);
    // A tab is shown as it takes focus, as tabs are: the arrows browse the families.
    const focused = document.activeElement?.getAttribute("data-value");
    const next = families.find((candidate) => candidate.id === focused);
    if (next && next.id !== family?.id) {
      setFamilyId(next.id);
      setExpandedId(undefined);
    }
  };

  const onLibraryKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLElement>("[data-nav]"),
    ];
    const current = document.activeElement as HTMLElement | null;
    if (!current || !items.includes(current)) {
      return;
    }
    if (event.key === "Home") {
      moveFocus(event, items, () => 0);
      return;
    }
    if (event.key === "End") {
      moveFocus(event, items, () => items.length - 1);
      return;
    }
    if (current.hasAttribute("data-subgroup")) {
      // A subgroup header: down and up walk the list; right opens it and left closes it.
      const id = current.getAttribute("data-value") as StrategyMetricCategoryId;
      if (event.key === "ArrowDown") {
        moveFocus(event, items, (index) => index + 1);
      } else if (event.key === "ArrowUp") {
        moveFocus(event, items, (index) => index - 1);
      } else if (event.key === "ArrowRight" && expanded !== id) {
        event.preventDefault();
        setExpandedId(id);
      } else if (event.key === "ArrowLeft" && expanded === id) {
        event.preventDefault();
        setExpandedId(null);
      }
      return;
    }
    // An option: the arrows follow the grid as it is drawn, a row at a time up and down.
    const grid = current.closest("[data-option-grid]");
    const columns = gridColumns(grid);
    const within = grid
      ? [...grid.querySelectorAll<HTMLElement>("[data-option]")]
      : [];
    const position = within.indexOf(current);
    const index = items.indexOf(current);
    if (event.key === "ArrowRight") {
      moveFocus(event, items, () =>
        position < within.length - 1 ? index + 1 : null,
      );
    } else if (event.key === "ArrowLeft") {
      moveFocus(event, items, () => (position > 0 ? index - 1 : null));
    } else if (event.key === "ArrowDown") {
      moveFocus(event, items, () => {
        if (position + columns < within.length) {
          return index + columns;
        }
        // Past the grid's last row: the next subgroup's header, when there is one.
        const after = index + (within.length - position);
        return after < items.length ? after : null;
      });
    } else if (event.key === "ArrowUp") {
      moveFocus(event, items, () => {
        if (position - columns >= 0) {
          return index - columns;
        }
        // Above the grid's first row: the subgroup's own header, when it has one.
        const header = index - position - 1;
        return header >= 0 ? header : null;
      });
    }
  };

  const renderOptions = (
    category: StrategyMetricCategory,
    labelledBy: string | undefined,
    close: (returnFocus: boolean) => void,
  ) => (
    <ul
      className={operand.optionGrid}
      id={optionsId(category.id)}
      data-option-grid=""
      data-category={category.id}
      {...(labelledBy
        ? { "aria-labelledby": labelledBy }
        : { "aria-label": category.label })}
    >
      {category.options.map((option) => {
        const key = strategyMetricKey(option.metric);
        return (
          <li key={key}>
            <button
              type="button"
              className={operand.option}
              data-option=""
              data-nav=""
              data-testid="metric-picker-option"
              data-value={key}
              aria-pressed={key === selectedKey}
              title={option.label}
              onClick={() => {
                if (key !== selectedKey) {
                  onChange(option.metric);
                }
                close(true);
              }}
            >
              {option.label}
            </button>
          </li>
        );
      })}
    </ul>
  );

  // One line under the source, and only ever one: why the ETF choice is unavailable, what a browse
  // is waiting for, or what a change of source made during this opening replaced.
  const hint: { kind: "UNAVAILABLE" | "PENDING" | "OUTCOME"; text: string } | null =
    !etfOffered
      ? {
          kind: "UNAVAILABLE",
          text: "An ETF or the stock's sector can be read by a condition only, not by a trigger.",
        }
      : pending && (shownEtf || sectorShown)
        ? {
            kind: "PENDING",
            text: `${strategyMetricLabel(metric)} is read from the stock only. Choose a metric below to read ${shownEtf ? shownEtf.ticker : "each stock's sector ETF"} instead.`,
          }
        : movedSource && notice
          ? { kind: "OUTCOME", text: notice }
          : null;
  const hintId = `${baseId}-hint`;

  return (
    <PickerPopover
      label={label}
      testId="metric-picker"
      value={selectedKey}
      // The collapsed control names the source with the metric — `XLK · RSI 14D` — so two rules
      // reading different sources can never be mistaken for each other.
      display={offered ? strategyMetricLabel(metric) : "Unavailable metric"}
      invalid={invalid}
      {...(describedBy ? { describedBy } : {})}
      sizing="content"
      onOpen={() => {
        setBrowseSource(committedSource);
        if (committedSource?.kind === "ETF") {
          setEtfCode(committedSource.code);
        }
        setFamilyId(null);
        setExpandedId(undefined);
        setMovedSource(false);
      }}
      // Focus goes to the rule's own metric when it is on show, otherwise to the family being shown.
      initialFocus={(panel) =>
        panel.querySelector<HTMLElement>(
          '[data-option][aria-pressed="true"]',
        ) ?? panel.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      }
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {({ close }) => (
        <>
          <div className={styles.source}>
            <span className={styles.sourceLabel} id={`${baseId}-source`}>
              Data source
            </span>
            <div
              className={styles.sourceChoices}
              role="radiogroup"
              aria-labelledby={`${baseId}-source`}
              // Why the ETF choice is disabled belongs to the group that holds it.
              aria-describedby={hint?.kind === "UNAVAILABLE" ? hintId : undefined}
              data-testid="metric-picker-sources"
            >
              <label className={styles.sourceChoice}>
                <input
                  type="radio"
                  className={styles.sourceInput}
                  name={`${baseId}-source`}
                  data-testid="metric-picker-source"
                  data-value="STOCK"
                  checked={shownSource === undefined}
                  onChange={() => showSource(undefined)}
                />
                <span className={styles.sourceFace}>Stock</span>
              </label>
              <label className={styles.sourceChoice}>
                <input
                  type="radio"
                  className={styles.sourceInput}
                  name={`${baseId}-source`}
                  data-testid="metric-picker-source"
                  data-value="ETF"
                  checked={shownSource?.kind === "ETF"}
                  disabled={!etfOffered || etfCode === undefined}
                  onChange={() => {
                    if (etfCode !== undefined) {
                      showSource({ kind: "ETF", code: etfCode });
                    }
                  }}
                />
                <span className={styles.sourceFace}>ETF</span>
              </label>
              <label className={styles.sourceChoice}>
                <input
                  type="radio"
                  className={styles.sourceInput}
                  name={`${baseId}-source`}
                  data-testid="metric-picker-source"
                  data-value="STOCK_SECTOR"
                  checked={sectorShown}
                  disabled={!etfOffered}
                  onChange={() => showSource({ kind: "STOCK_SECTOR" })}
                />
                <span className={styles.sourceFace}>
                  {STOCK_SECTOR_SOURCE_LABEL}
                </span>
              </label>
            </div>
            {sectorShown ? (
              // No fund to choose: each evaluated stock decides its own. Said where the ETF select
              // would be, so the absence of a picker reads as a rule rather than as a gap.
              <p
                className={styles.sectorNote}
                data-testid="metric-picker-sector-note"
              >
                {SECTOR_NOTE}
              </p>
            ) : null}
            {shownSource?.kind === "ETF" ? (
              <div className={styles.etf}>
                <Select
                  density="compact"
                  testId="metric-picker-etf"
                  aria-label="ETF"
                  value={shownSource.code}
                  onValueChange={(code) => {
                    if (isStrategyEtfSourceCode(code)) {
                      setEtfCode(code);
                      showSource({ kind: "ETF", code });
                    }
                  }}
                  groups={STRATEGY_ETF_SOURCE_GROUPS.map((group) => ({
                    // The picker's own group names (`Sectors`), never the Dashboard's headings.
                    label: group.pickerLabel,
                    options: group.etfs.map((etf) => ({
                      value: etf.code,
                      label: `${etf.ticker} — ${etf.label}`,
                    })),
                  }))}
                />
              </div>
            ) : null}
          </div>

          {hint ? (
            <p
              className={styles.hint}
              id={hintId}
              data-testid="metric-picker-hint"
              data-kind={hint.kind}
              // A browse waiting for a metric is announced as it appears. An outcome is not: the
              // row's own line is its live region, and this is the same sentence where it can be
              // seen while the popover covers that line.
              role={hint.kind === "PENDING" ? "status" : undefined}
              aria-hidden={hint.kind === "OUTCOME" ? "true" : undefined}
            >
              {hint.text}
            </p>
          ) : null}

          <div
            className={styles.families}
            role="tablist"
            aria-label="Metric families"
            onKeyDown={onFamilyKeyDown}
          >
            {families.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                id={tabId(candidate.id)}
                className={styles.family}
                data-testid="metric-picker-family"
                data-value={candidate.id}
                // Marks where the rule's metric lives while another family is being browsed.
                data-current={
                  !pending && offered && candidate.id === homeFamilyId
                    ? "true"
                    : undefined
                }
                aria-selected={candidate.id === family?.id}
                aria-controls={libraryId}
                tabIndex={candidate.id === family?.id ? 0 : -1}
                onClick={() => {
                  setFamilyId(candidate.id);
                  setExpandedId(undefined);
                }}
              >
                {candidate.label}
              </button>
            ))}
          </div>

          {family ? (
            <div
              className={styles.library}
              id={libraryId}
              role="tabpanel"
              aria-labelledby={tabId(family.id)}
              data-testid="metric-picker-options"
              data-family={family.id}
              onKeyDown={onLibraryKeyDown}
            >
              {grouped
                ? family.categories.map((category) => {
                    const open = category.id === expanded;
                    return (
                      <div
                        key={category.id}
                        className={styles.subgroup}
                        data-open={open ? "true" : undefined}
                      >
                        <button
                          type="button"
                          className={styles.subgroupHeader}
                          id={headerId(category.id)}
                          data-subgroup=""
                          data-nav=""
                          data-testid="metric-picker-category"
                          data-value={category.id}
                          data-label={category.label}
                          data-current={
                            !pending && offered && category.id === homeCategoryId
                              ? "true"
                              : undefined
                          }
                          aria-expanded={open}
                          aria-controls={optionsId(category.id)}
                          onClick={() =>
                            setExpandedId(open ? null : category.id)
                          }
                        >
                          <span className={styles.subgroupChevron} aria-hidden="true" />
                          <span className={styles.subgroupLabel}>
                            {category.label}
                          </span>
                          <span className={styles.subgroupCount} aria-hidden="true">
                            {category.options.length}
                          </span>
                        </button>
                        {open
                          ? renderOptions(category, headerId(category.id), close)
                          : null}
                      </div>
                    );
                  })
                : family.categories.map((category) => (
                    <div key={category.id} className={styles.subgroup}>
                      {renderOptions(category, undefined, close)}
                    </div>
                  ))}
            </div>
          ) : null}
        </>
      )}
    </PickerPopover>
  );
}
