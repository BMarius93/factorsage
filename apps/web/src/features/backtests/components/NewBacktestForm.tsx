"use client";

import {
  BACKTEST_MAX_MAXIMUM_POSITIONS,
  BACKTEST_MAX_PERIOD_YEARS,
  BACKTEST_MIN_MAXIMUM_POSITIONS,
  DEFAULT_BENCHMARK_CODE,
  isTerminalBacktestStatus,
  type EntitlementReasonCode,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Notice } from "../../../components/ui/Notice";
import { EntitlementNotice } from "../../../components/ui/EntitlementNotice";
import { useEntitlements } from "../../auth/hooks/use-entitlements";
import { useActiveBacktestRuns } from "../hooks/use-backtest-runs";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { WorkflowFooter } from "../../../components/ui/WorkflowFooter";
import forms from "../../../components/ui/forms.module.css";
import {
  entitlementReason,
  requestFailureMessage,
} from "../../../lib/api/entitlement-errors";
import {
  premiumPlansLabel,
  premiumPlansPhrase,
} from "../../billing/components/PremiumContent";
import { createBacktestRun } from "../api/backtests-api";
import { useBacktestOptions } from "../hooks/use-backtest-options";
import { readBacktestPrefill } from "../utils/prefill";
import { queueFullMessage } from "../utils/queue";
import {
  defaultBacktestPeriod,
  fullPositionHelpText,
  exceedsPeriodYears,
  maximumBacktestStart,
  startForPeriodYears,
  validateBacktestForm,
  type BacktestFormErrors,
  type BacktestFormValues,
} from "../utils/submission";
import { EntitySelect } from "../../../components/ui/EntitySelect";
import { Select } from "../../../components/ui/Select";
import { MoneyInput } from "./MoneyInput";
import styles from "./NewBacktestForm.module.css";

/**
 * The form's fields in reading order, with the control each error belongs to. Client validation
 * moves focus to the first invalid one (UI-005) instead of leaving it on "Run backtest".
 */
const FIELD_CONTROLS: readonly (readonly [keyof BacktestFormValues, string])[] =
  [
    ["strategyId", "backtest-strategy"],
    ["stockListId", "backtest-list"],
    ["benchmarkCode", "backtest-benchmark"],
    ["startDate", "backtest-start"],
    ["endDate", "backtest-end"],
    ["initialCapital", "backtest-capital"],
    ["monthlyContribution", "backtest-contribution"],
    ["maximumPositions", "backtest-max-positions"],
  ];

/**
 * The id a field's error or hint is rendered under, so the control can name it with
 * `aria-describedby` (BT-7): a screen reader then reads the reason with the field instead of as a
 * detached alert, and focusing the first invalid field on submit is enough to explain it.
 */
function describedBy(
  control: string,
  parts: { readonly error?: boolean; readonly hint?: boolean },
): string | undefined {
  if (parts.error) {
    return `${control}-error`;
  }
  return parts.hint ? `${control}-hint` : undefined;
}

/**
 * What a plan without the point-in-time universe is told, before and instead of a refusal (PR-1).
 * The plans that include it are read from the entitlement matrix, never written down here.
 */
const UNIVERSE_NOT_INCLUDED = `Backtests over the S&P 500 Historical PIT universe are part of ${premiumPlansPhrase()}.`;

/** The same, for any other premium built-in the plan does not include. */
const PREMIUM_LIST_NOT_INCLUDED = `Premium lists are part of ${premiumPlansPhrase()}.`;
const PREMIUM_STRATEGY_NOT_INCLUDED = `Premium strategies are part of ${premiumPlansPhrase()}.`;

/** How a picker marks a choice the plan does not include: the plans that do. */
const NOT_INCLUDED_MARK = ` · ${premiumPlansLabel()}`;

const DEFAULT_INITIAL_CAPITAL = "10000";
const DEFAULT_MAXIMUM_POSITIONS = "10";

const EMPTY_VALUES: BacktestFormValues = {
  strategyId: "",
  stockListId: "",
  benchmarkCode: "",
  startDate: "",
  endDate: "",
  initialCapital: DEFAULT_INITIAL_CAPITAL,
  monthlyContribution: "",
  maximumPositions: DEFAULT_MAXIMUM_POSITIONS,
};

function submissionMessage(error: unknown): string {
  // A full deployment-wide queue is this form's own refusal, so it is handled before the shared
  // translator, which would otherwise call it an unexpected failure: the API's sentence says the
  // queue is full and when to come back, and nothing was created.
  //
  // The API validates the same document again, and separately decides whether the caller's plan
  // permits this run at all. When it disagrees on either count its product-vocabulary message is
  // what the user needs to read — a plan limit especially, because "try again in a moment" would
  // be false: the next attempt fails identically.
  return (
    queueFullMessage(error) ??
    requestFailureMessage(
      error,
      "The backtest could not be submitted right now. Try again in a moment.",
    )
  );
}

/**
 * Submits one backtest run.
 *
 * Every choice comes from the endpoint that owns it — strategies, stock lists and the benchmark
 * catalog alike — so no option list lives in this file. The allocation input is `maximumPositions`
 * and nothing else: the full-position fraction is derived as `1 / maximumPositions` and shown as
 * help text, because a user-entered maximum-allocation percentage is deliberately not part of the
 * product.
 */
export function NewBacktestForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, strategies, lists, benchmarks, retry } = useBacktestOptions();
  const [values, setValues] = useState<BacktestFormValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<BacktestFormErrors>({});
  const [submitError, setSubmitError] = useState<{
    readonly message: string;
    readonly reason: EntitlementReasonCode | undefined;
  } | null>(null);
  const plan = useEntitlements();
  const limits = plan.status === "ready" ? plan.entitlements.backtests : null;
  const runs = useActiveBacktestRuns();
  // Runs still holding a concurrency slot, so the limit can be seen before submitting (UI-020).
  const inFlight = runs.runs.filter(
    (run) => !isTerminalBacktestStatus(run.status),
  );
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // The default period is computed after mount: the server and the browser would not agree on
    // "today" during hydration.
    const period = defaultBacktestPeriod(new Date());
    setValues((current) =>
      current.startDate === "" && current.endDate === ""
        ? { ...current, ...period }
        : current,
    );
  }, []);

  useEffect(() => {
    if (status !== "ready") {
      return;
    }
    // The catalog decides the default benchmark, never this component: `SP500` is preselected when
    // the API offers it and the first available entry otherwise.
    setValues((current) => {
      if (current.benchmarkCode !== "") {
        return current;
      }
      const preferred =
        benchmarks.find((entry) => entry.code === DEFAULT_BENCHMARK_CODE) ??
        benchmarks[0];
      return preferred === undefined
        ? current
        : { ...current, benchmarkCode: preferred.code };
    });
  }, [status, benchmarks]);

  const prefill = useMemo(
    () => readBacktestPrefill(searchParams),
    [searchParams],
  );
  const prefillApplied = useRef(false);

  useEffect(() => {
    if (status !== "ready" || prefillApplied.current) {
      return;
    }
    prefillApplied.current = true;
    // A link names what it wants backtested — an entity header, a Guest's return from sign-in,
    // "Edit and run again" from a finished run. Only choices the caller can actually make are
    // applied: an unknown id or benchmark is ignored and leaves that field as it was.
    setValues((current) => ({
      ...current,
      ...(prefill.strategyId &&
      strategies.some((strategy) => strategy.id === prefill.strategyId)
        ? { strategyId: prefill.strategyId }
        : {}),
      ...(prefill.stockListId &&
      lists.some((list) => list.id === prefill.stockListId)
        ? { stockListId: prefill.stockListId }
        : {}),
      ...(prefill.benchmarkCode &&
      benchmarks.some((benchmark) => benchmark.code === prefill.benchmarkCode)
        ? { benchmarkCode: prefill.benchmarkCode }
        : {}),
      ...(prefill.startDate ? { startDate: prefill.startDate } : {}),
      ...(prefill.endDate ? { endDate: prefill.endDate } : {}),
      ...(prefill.initialCapital !== undefined
        ? { initialCapital: String(prefill.initialCapital) }
        : {}),
      ...(prefill.monthlyContribution !== undefined
        ? {
            monthlyContribution:
              prefill.monthlyContribution > 0
                ? String(prefill.monthlyContribution)
                : "",
          }
        : {}),
      ...(prefill.maximumPositions !== undefined
        ? { maximumPositions: String(prefill.maximumPositions) }
        : {}),
    }));
  }, [status, strategies, lists, benchmarks, prefill]);

  const update = <Key extends keyof BacktestFormValues>(
    key: Key,
    value: BacktestFormValues[Key],
  ) => {
    setValues((current) => ({ ...current, [key]: value }));
    // Correcting a field clears its own complaint immediately; the rest stay until resubmission.
    setErrors((current) =>
      current[key] === undefined ? current : { ...current, [key]: undefined },
    );
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const validated = validateBacktestForm(values);
    // Premium content the plan does not include — a locked strategy or list, or a universe with no
    // allowance — is refused here, before a request that could only be refused: the server still
    // enforces it, but the user hears it beside the field, with the way to the plans, instead of as
    // a failed submission (PR-1 / BT-4).
    const found: BacktestFormErrors = {
      ...validated.errors,
      ...(strategyLocked && validated.errors.strategyId === undefined
        ? { strategyId: PREMIUM_STRATEGY_NOT_INCLUDED }
        : {}),
      ...(listNotIncluded && validated.errors.stockListId === undefined
        ? { stockListId: listNotIncludedMessage }
        : {}),
    };
    const request =
      strategyLocked || listNotIncluded ? null : validated.request;
    setErrors(found);
    setSubmitError(null);
    if (request === null) {
      const first = FIELD_CONTROLS.find(([key]) => found[key] !== undefined);
      if (first) {
        document.getElementById(first[1])?.focus();
      }
      return;
    }

    setPending(true);
    try {
      const run = await createBacktestRun(request);
      router.push(`/backtests/${run.id}`);
    } catch (caught) {
      setSubmitError({
        message: submissionMessage(caught),
        reason: entitlementReason(caught),
      });
      setPending(false);
    }
  };

  const planYears = limits?.maxHistoricalYears ?? null;
  const maxSymbols = limits?.maxSymbols ?? null;
  const maxConcurrent = limits?.maxConcurrentRuns ?? null;
  const periodTooLong = exceedsPeriodYears(
    values.startDate,
    values.endDate,
    planYears,
  );
  const fitPeriodToPlan = () => {
    if (planYears !== null && values.endDate !== "") {
      update("startDate", startForPeriodYears(values.endDate, planYears));
    }
  };
  const selectedStrategy = strategies.find(
    (strategy) => strategy.id === values.strategyId,
  );
  // A premium built-in strategy the plan does not include: the API withholds its rules and
  // refuses a backtest over it.
  const strategyLocked = selectedStrategy?.locked === true;
  const selectedList = lists.find((list) => list.id === values.stockListId);
  const chosenListSize = selectedList?.itemCount;
  // The built-in point-in-time index universe is measured by the most members it holds at once,
  // against its own allowance (`docs/decisions/sp500-historical-pit-v1.md`); the server measures the
  // same quantity over the run's own period and decides.
  const chosenUniverse = selectedList?.universe;
  const maxUniverse = limits?.maxIndexUniverseConstituents ?? null;
  // Not "too large" but not part of the plan at all: premium content the plan does not include, or
  // a universe allowance of zero. Only this case is decided before submission; a positive
  // allowance is measured by the server over the run's own period, which may hold fewer members
  // than the universe's all-time peak.
  const listNotIncluded =
    selectedList?.locked === true ||
    (chosenUniverse !== undefined && maxUniverse === 0);
  const listNotIncludedMessage =
    chosenUniverse !== undefined
      ? UNIVERSE_NOT_INCLUDED
      : PREMIUM_LIST_NOT_INCLUDED;
  const universeTooLarge =
    !listNotIncluded &&
    chosenUniverse !== undefined &&
    maxUniverse !== null &&
    chosenUniverse.peakSimultaneousMembers > maxUniverse;
  /** The pickers mark what the plan does not include, so choosing it is never a surprise. */
  const listOptionLabel = (item: {
    readonly id: string;
    readonly name: string;
  }) => {
    const list = lists.find((entry) => entry.id === item.id);
    return list?.locked === true ||
      (list?.universe !== undefined && maxUniverse === 0)
      ? `${item.name}${NOT_INCLUDED_MARK}`
      : item.name;
  };
  const strategyOptionLabel = (item: {
    readonly id: string;
    readonly name: string;
  }) =>
    strategies.find((entry) => entry.id === item.id)?.locked === true
      ? `${item.name}${NOT_INCLUDED_MARK}`
      : item.name;
  /** The way to the plans, beside a choice the plan does not include. */
  const seePlans = (testId: string) => (
    <Link className={styles.noticeLink} href="/billing" data-testid={testId}>
      See plans
    </Link>
  );
  const listNotIncludedTestId =
    chosenUniverse !== undefined
      ? "backtest-universe-over-limit"
      : "backtest-list-locked";
  const listSeePlansTestId =
    chosenUniverse !== undefined
      ? "backtest-universe-see-plans"
      : "backtest-list-see-plans";
  const listTooLarge =
    chosenUniverse === undefined &&
    maxSymbols !== null &&
    chosenListSize !== undefined &&
    chosenListSize > maxSymbols;
  const atConcurrency =
    maxConcurrent !== null &&
    runs.status === "ready" &&
    inFlight.length >= maxConcurrent;

  /** The next step that fits each refusal, beside "See plans" (UI-020). */
  const refusalRecovery = (reason: EntitlementReasonCode) => {
    switch (reason) {
      case "ENTITLEMENT_BACKTEST_HISTORY_LIMIT":
        return planYears === null ? null : (
          <button
            type="button"
            className={forms.primaryButton}
            data-testid="backtest-fit-period"
            onClick={fitPeriodToPlan}
          >
            Set the period to {planYears} years
          </button>
        );
      case "ENTITLEMENT_BACKTEST_CONCURRENCY_LIMIT":
        return inFlight[0] ? (
          <Link
            className={forms.primaryButton}
            href={`/backtests/${inFlight[0].id}`}
            data-testid="backtest-open-running"
          >
            View the running backtest
          </Link>
        ) : null;
      case "ENTITLEMENT_BACKTEST_SYMBOL_LIMIT":
        // Removing stocks is only advice for a list the user can edit: a built-in list, and above
        // all the point-in-time universe, is read-only, and its allowance is not a list size (BT-4).
        return (
          <span className={styles.recoveryHint}>
            {chosenUniverse !== undefined
              ? "Choose a different list."
              : selectedList?.ownership === "SYSTEM"
                ? "Choose a smaller list."
                : "Choose a smaller list, or remove stocks from this one."}
          </span>
        );
      default:
        return null;
    }
  };

  const maximumPositions = Number(values.maximumPositions);
  const helpText =
    Number.isInteger(maximumPositions) &&
    maximumPositions >= BACKTEST_MIN_MAXIMUM_POSITIONS &&
    maximumPositions <= BACKTEST_MAX_MAXIMUM_POSITIONS
      ? fullPositionHelpText(maximumPositions)
      : "A full position is 1 / maximum positions of the portfolio; a strategy's BUY level is a share of that.";

  // What the phone action bar says is about to run. Names the two things the user chose,
  // because those are what a mis-selection shows up in; never a credit balance.
  const chosenStrategy = selectedStrategy?.name;
  const chosenList = lists.find((list) => list.id === values.stockListId)?.name;
  const summary =
    chosenStrategy && chosenList
      ? `${chosenStrategy} over ${chosenList}`
      : "Choose a strategy and a stock list";

  if (status === "error") {
    return (
      <PageContainer width="reading">
        <div className={styles.page}>
          <EmptyState
            as="h1"
            variant="error"
            title="The submission form could not be loaded"
            body={
              <p>
                Your strategies, lists and benchmarks are needed before a
                backtest can be submitted. This is usually temporary.
              </p>
            }
            actions={
              <button
                type="button"
                className={forms.secondaryButton}
                onClick={retry}
              >
                Try again
              </button>
            }
          />
        </div>
      </PageContainer>
    );
  }

  const loading = status === "loading";
  const missingPrerequisite =
    status === "ready" && (strategies.length === 0 || lists.length === 0);

  return (
    <PageContainer width="reading">
      <div className={styles.page} data-testid="new-backtest-page">
        <PageHeader
          variant="plain"
          back={{ href: "/backtests", label: "Backtests" }}
          title="New backtest"
          lead="One strategy, one stock list, one historical period. The run executes in the background and its results appear while it progresses."
        />

        {prefill.fromRunId && status === "ready" ? (
          <Notice tone="info" testId="backtest-prefilled-from-run">
            <p>
              Prefilled from{" "}
              <Link
                className={styles.noticeLink}
                href={`/backtests/${encodeURIComponent(prefill.fromRunId)}`}
              >
                an earlier run
              </Link>
              , which stays unchanged. The strategy runs as it is now, and a
              strategy or list deleted since is not preselected.
            </p>
          </Notice>
        ) : null}

        {missingPrerequisite ? (
          <Notice tone="warning" testId="backtest-prerequisites">
            <p>
              A backtest needs both a strategy and a stock list.
              {strategies.length === 0 ? (
                <>
                  {" "}
                  <Link href="/strategies/new">Create a strategy</Link> first.
                </>
              ) : null}
              {lists.length === 0 ? (
                <>
                  {" "}
                  <Link href="/lists?new=1">Create a stock list</Link> first.
                </>
              ) : null}
            </p>
          </Notice>
        ) : null}

        {atConcurrency ? (
          // The concurrency limit, before the form is filled in (UI-020).
          <EntitlementNotice
            announce="status"
            testId="backtest-concurrency-notice"
            title={
              maxConcurrent === 1
                ? "A backtest is already running"
                : `${inFlight.length} backtests are already running`
            }
            message={`Your plan runs ${maxConcurrent} backtest${maxConcurrent === 1 ? "" : "s"} at a time. You can prepare this one now and run it when a slot frees.`}
            recovery={
              inFlight[0] ? (
                <Link
                  className={forms.secondaryButton}
                  href={`/backtests/${inFlight[0].id}`}
                >
                  View progress
                </Link>
              ) : null
            }
          />
        ) : null}

        <form
          className={styles.form}
          onSubmit={submit}
          noValidate
          data-testid="new-backtest-form"
        >
          <SectionCard
            id="backtest-configuration"
            ariaLabel="Backtest configuration"
          >
            <fieldset className={styles.group}>
              <legend className={styles.groupTitle}>What to run</legend>
              <div className={styles.grid}>
                <div className={forms.field}>
                  <label className={forms.label} htmlFor="backtest-strategy">
                    Strategy
                  </label>
                  <EntitySelect
                    id="backtest-strategy"
                    kind="strategy"
                    testId="backtest-strategy"
                    items={strategies}
                    value={values.strategyId}
                    loading={loading}
                    invalid={errors.strategyId !== undefined}
                    {...(errors.strategyId
                      ? { describedBy: "backtest-strategy-error" }
                      : strategyLocked
                        ? { describedBy: "backtest-strategy-hint" }
                        : {})}
                    optionLabel={strategyOptionLabel}
                    onValueChange={(id) => update("strategyId", id)}
                  />
                  {errors.strategyId ? (
                    <p
                      className={forms.hint}
                      id="backtest-strategy-error"
                      data-testid={
                        strategyLocked ? "backtest-strategy-locked" : undefined
                      }
                    >
                      {errors.strategyId}
                      {strategyLocked ? (
                        <> {seePlans("backtest-strategy-see-plans")}</>
                      ) : null}
                    </p>
                  ) : strategyLocked ? (
                    <p
                      className={styles.limitText}
                      id="backtest-strategy-hint"
                      data-state="over"
                      data-testid="backtest-strategy-locked"
                    >
                      {PREMIUM_STRATEGY_NOT_INCLUDED}{" "}
                      {seePlans("backtest-strategy-see-plans")}
                    </p>
                  ) : null}
                </div>

                <div className={forms.field}>
                  <label className={forms.label} htmlFor="backtest-list">
                    Stock list
                  </label>
                  <EntitySelect
                    id="backtest-list"
                    kind="list"
                    testId="backtest-list"
                    items={lists}
                    value={values.stockListId}
                    loading={loading}
                    invalid={errors.stockListId !== undefined}
                    {...(errors.stockListId
                      ? { describedBy: "backtest-list-error" }
                      : listNotIncluded ||
                          listTooLarge ||
                          universeTooLarge ||
                          chosenUniverse
                        ? { describedBy: "backtest-list-hint" }
                        : {})}
                    optionLabel={listOptionLabel}
                    onValueChange={(id) => update("stockListId", id)}
                  />
                  {errors.stockListId ? (
                    <p
                      className={forms.hint}
                      id="backtest-list-error"
                      data-testid={
                        listNotIncluded ? listNotIncludedTestId : undefined
                      }
                    >
                      {errors.stockListId}
                      {listNotIncluded ? (
                        <> {seePlans(listSeePlansTestId)}</>
                      ) : null}
                    </p>
                  ) : listNotIncluded ? (
                    <p
                      className={styles.limitText}
                      id="backtest-list-hint"
                      data-state="over"
                      data-testid={listNotIncludedTestId}
                    >
                      {listNotIncludedMessage} {seePlans(listSeePlansTestId)}
                    </p>
                  ) : listTooLarge ? (
                    <p
                      className={styles.limitText}
                      id="backtest-list-hint"
                      data-state="over"
                      data-testid="backtest-list-over-limit"
                    >
                      This list has {chosenListSize} stocks; your plan runs up
                      to {maxSymbols} per backtest.
                    </p>
                  ) : universeTooLarge ? (
                    <p
                      className={styles.limitText}
                      id="backtest-list-hint"
                      data-state="over"
                      data-testid="backtest-universe-over-limit"
                    >
                      {`This universe holds up to ${chosenUniverse.peakSimultaneousMembers} members at once; your plan runs up to ${maxUniverse}.`}
                    </p>
                  ) : chosenUniverse ? (
                    <p
                      className={forms.hint}
                      id="backtest-list-hint"
                      data-testid="backtest-universe-summary"
                    >
                      Point-in-time membership:{" "}
                      {chosenUniverse.distinctSecurities} stocks over time, up
                      to {chosenUniverse.peakSimultaneousMembers} at once. Each
                      stock is bought only while it was a member.
                    </p>
                  ) : null}
                </div>

                <div className={forms.field}>
                  <label className={forms.label} htmlFor="backtest-benchmark">
                    Benchmark
                  </label>
                  <Select
                    id="backtest-benchmark"
                    testId="backtest-benchmark"
                    value={values.benchmarkCode}
                    disabled={loading}
                    invalid={errors.benchmarkCode !== undefined}
                    aria-describedby={describedBy("backtest-benchmark", {
                      error: errors.benchmarkCode !== undefined,
                      hint: true,
                    })}
                    onValueChange={(code) => update("benchmarkCode", code)}
                    placeholder="Select a benchmark…"
                    options={benchmarks.map((benchmark) => ({
                      value: benchmark.code,
                      label: benchmark.name,
                    }))}
                  />
                  {errors.benchmarkCode ? (
                    <p className={forms.hint} id="backtest-benchmark-error">
                      {errors.benchmarkCode}
                    </p>
                  ) : (
                    <p className={forms.hint} id="backtest-benchmark-hint">
                      What the run&apos;s growth is compared against.
                    </p>
                  )}
                </div>
              </div>
            </fieldset>

            <fieldset className={styles.group}>
              <legend className={styles.groupTitle}>Period</legend>
              <div className={styles.grid}>
                <div className={forms.field}>
                  <label className={forms.label} htmlFor="backtest-start">
                    Start date
                  </label>
                  <div className={styles.dateRow}>
                    <input
                      id="backtest-start"
                      className={forms.input}
                      data-testid="backtest-start"
                      type="date"
                      value={values.startDate}
                      aria-invalid={errors.startDate !== undefined}
                      aria-describedby={describedBy("backtest-start", {
                        error: errors.startDate !== undefined,
                      })}
                      onChange={(event) =>
                        update("startDate", event.target.value)
                      }
                    />
                    {/* The furthest back a V1 run may reach. It moves only the start: the end date
                      is the user's, and the ordinary period validation still applies. */}
                    <button
                      type="button"
                      className={styles.maxButton}
                      data-testid="backtest-start-max"
                      onClick={() =>
                        update(
                          "startDate",
                          maximumBacktestStart(new Date(), planYears),
                        )
                      }
                      title={`The longest period your plan allows — ${Math.min(
                        planYears ?? BACKTEST_MAX_PERIOD_YEARS,
                        BACKTEST_MAX_PERIOD_YEARS,
                      )} years back`}
                    >
                      MAX
                    </button>
                  </div>
                  {errors.startDate ? (
                    <p className={forms.hint} id="backtest-start-error">
                      {errors.startDate}
                    </p>
                  ) : null}
                </div>

                <div className={forms.field}>
                  <label className={forms.label} htmlFor="backtest-end">
                    End date
                  </label>
                  <input
                    id="backtest-end"
                    className={forms.input}
                    data-testid="backtest-end"
                    type="date"
                    value={values.endDate}
                    aria-invalid={errors.endDate !== undefined}
                    aria-describedby={describedBy("backtest-end", {
                      error: errors.endDate !== undefined,
                    })}
                    onChange={(event) => update("endDate", event.target.value)}
                  />
                  {errors.endDate ? (
                    <p className={forms.hint} id="backtest-end-error">
                      {errors.endDate}
                    </p>
                  ) : null}
                </div>
              </div>
              {planYears !== null && planYears < BACKTEST_MAX_PERIOD_YEARS ? (
                // The plan's period allowance, before submit (UI-023): a period-length limit,
                // not a look-back — any start date is fine if the period fits.
                <div
                  className={styles.limitRow}
                  data-state={periodTooLong ? "over" : "ok"}
                  data-testid="backtest-period-limit"
                >
                  <p className={styles.limitText}>
                    {periodTooLong
                      ? `This period is longer than your plan allows. Backtest periods can be up to ${planYears} years long.`
                      : `Your plan allows backtest periods up to ${planYears} years long. MAX sets the longest it allows.`}
                  </p>
                  {periodTooLong ? (
                    <button
                      type="button"
                      className={styles.maxButton}
                      data-testid="backtest-period-fit"
                      onClick={fitPeriodToPlan}
                    >
                      Set to {planYears} years
                    </button>
                  ) : null}
                </div>
              ) : null}
            </fieldset>

            <fieldset className={styles.group}>
              <legend className={styles.groupTitle}>
                Capital and allocation
              </legend>
              <div className={styles.grid}>
                <div className={forms.field}>
                  <label className={forms.label} htmlFor="backtest-capital">
                    Initial capital
                    <span className={styles.srOnly}> in US dollars</span>
                  </label>
                  <MoneyInput
                    id="backtest-capital"
                    testId="backtest-capital"
                    value={values.initialCapital}
                    invalid={errors.initialCapital !== undefined}
                    {...(errors.initialCapital
                      ? { describedBy: "backtest-capital-error" }
                      : {})}
                    onValueChange={(raw) => update("initialCapital", raw)}
                  />
                  {errors.initialCapital ? (
                    <p className={forms.hint} id="backtest-capital-error">
                      {errors.initialCapital}
                    </p>
                  ) : null}
                </div>

                <div className={forms.field}>
                  <label
                    className={forms.label}
                    htmlFor="backtest-contribution"
                  >
                    Monthly contribution
                    <span className={styles.srOnly}> in US dollars</span>{" "}
                    <span aria-hidden="true">·</span> optional
                  </label>
                  <MoneyInput
                    id="backtest-contribution"
                    testId="backtest-contribution"
                    placeholder="0"
                    value={values.monthlyContribution}
                    invalid={errors.monthlyContribution !== undefined}
                    describedBy={
                      errors.monthlyContribution
                        ? "backtest-contribution-error"
                        : "backtest-contribution-hint"
                    }
                    onValueChange={(raw) => update("monthlyContribution", raw)}
                  />
                  {errors.monthlyContribution ? (
                    <p className={forms.hint} id="backtest-contribution-error">
                      {errors.monthlyContribution}
                    </p>
                  ) : (
                    <p className={forms.hint} id="backtest-contribution-hint">
                      Added to available cash on the first trading day of each
                      month. Leave empty for none.
                    </p>
                  )}
                </div>

                <div className={forms.field}>
                  <label
                    className={forms.label}
                    htmlFor="backtest-max-positions"
                  >
                    Maximum positions
                  </label>
                  <input
                    id="backtest-max-positions"
                    className={forms.input}
                    data-testid="backtest-max-positions"
                    type="number"
                    inputMode="numeric"
                    min={BACKTEST_MIN_MAXIMUM_POSITIONS}
                    max={BACKTEST_MAX_MAXIMUM_POSITIONS}
                    step="1"
                    value={values.maximumPositions}
                    aria-invalid={errors.maximumPositions !== undefined}
                    aria-describedby={
                      errors.maximumPositions
                        ? "backtest-max-positions-error backtest-max-positions-hint"
                        : "backtest-max-positions-hint"
                    }
                    onChange={(event) =>
                      update("maximumPositions", event.target.value)
                    }
                  />
                  {errors.maximumPositions ? (
                    <p className={forms.hint} id="backtest-max-positions-error">
                      {errors.maximumPositions}
                    </p>
                  ) : null}
                  <p
                    className={styles.derived}
                    id="backtest-max-positions-hint"
                    data-testid="full-position-help"
                  >
                    {helpText}
                  </p>
                </div>
              </div>
            </fieldset>
          </SectionCard>

          <WorkflowFooter
            testId="new-backtest-actions"
            error={
              submitError === null ? null : submitError.reason ? (
                <EntitlementNotice
                  message={submitError.message}
                  recovery={refusalRecovery(submitError.reason)}
                />
              ) : (
                submitError.message
              )
            }
            errorTestId="backtest-submit-error"
            summary={
              summary ? (
                <span data-testid="backtest-summary">{summary}</span>
              ) : null
            }
          >
            <Link className={forms.secondaryButton} href="/backtests">
              Cancel
            </Link>
            <button
              type="submit"
              className={forms.primaryButton}
              data-testid="submit-backtest"
              disabled={pending || loading}
            >
              {pending ? "Submitting…" : "Run backtest"}
            </button>
          </WorkflowFooter>
        </form>
      </div>
    </PageContainer>
  );
}
