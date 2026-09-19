"use client";

import {
  BACKTEST_MAX_INITIAL_CAPITAL,
  BACKTEST_MAX_MAXIMUM_POSITIONS,
  BACKTEST_MAX_MONTHLY_CONTRIBUTION,
  BACKTEST_MAX_PERIOD_YEARS,
  BACKTEST_MIN_INITIAL_CAPITAL,
  BACKTEST_MIN_MAXIMUM_POSITIONS,
  DEFAULT_BENCHMARK_CODE,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Notice } from "../../../components/ui/Notice";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { WorkflowFooter } from "../../../components/ui/WorkflowFooter";
import forms from "../../../components/ui/forms.module.css";
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import { createBacktestRun } from "../api/backtests-api";
import { useBacktestOptions } from "../hooks/use-backtest-options";
import { readBacktestPrefill } from "../utils/prefill";
import { OwnershipOptions } from "./OwnershipOptions";
import {
  defaultBacktestPeriod,
  fullPositionHelpText,
  maximumBacktestStart,
  validateBacktestForm,
  type BacktestFormErrors,
  type BacktestFormValues,
} from "../utils/submission";
import styles from "./NewBacktestForm.module.css";

/**
 * The form's fields in reading order, with the control each error belongs to. Client validation
 * moves focus to the first invalid one (UI-005) instead of leaving it on "Run backtest".
 */
const FIELD_CONTROLS: readonly (readonly [keyof BacktestFormValues, string])[] = [
  ["strategyId", "backtest-strategy"],
  ["stockListId", "backtest-list"],
  ["benchmarkCode", "backtest-benchmark"],
  ["startDate", "backtest-start"],
  ["endDate", "backtest-end"],
  ["initialCapital", "backtest-capital"],
  ["monthlyContribution", "backtest-contribution"],
  ["maximumPositions", "backtest-max-positions"],
];

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
  // The API validates the same document again, and separately decides whether the caller's plan
  // permits this run at all. When it disagrees on either count its product-vocabulary message is
  // what the user needs to read — a plan limit especially, because "try again in a moment" would
  // be false: the next attempt fails identically.
  return requestFailureMessage(
    error,
    "The backtest could not be submitted right now. Try again in a moment.",
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
  const [submitError, setSubmitError] = useState<string | null>(null);
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
    const { errors: found, request } = validateBacktestForm(values);
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
      setSubmitError(submissionMessage(caught));
      setPending(false);
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
  const chosenStrategy = strategies.find(
    (strategy) => strategy.id === values.strategyId,
  )?.name;
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
          <div className={styles.notice} data-testid="backtest-prerequisites">
            <p className={styles.noticeBody}>
              A backtest needs both a strategy and a stock list.
              {strategies.length === 0 ? (
                <>
                  {" "}
                  <Link className={styles.noticeLink} href="/strategies/new">
                    Create a strategy
                  </Link>{" "}
                  first.
                </>
              ) : null}
              {lists.length === 0 ? (
                <>
                  {" "}
                  <Link className={styles.noticeLink} href="/lists">
                    Create a stock list
                  </Link>{" "}
                  first.
                </>
              ) : null}
            </p>
          </div>
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
                  <select
                    id="backtest-strategy"
                    className={styles.select}
                    data-testid="backtest-strategy"
                    value={values.strategyId}
                    disabled={loading}
                    aria-invalid={errors.strategyId !== undefined}
                    onChange={(event) =>
                      update("strategyId", event.target.value)
                    }
                  >
                    <option value="">Select a strategy…</option>
                    <OwnershipOptions
                      items={strategies}
                      ownLabel="Your strategies"
                    />
                  </select>
                  {errors.strategyId ? (
                    <p className={forms.hint} role="alert">
                      {errors.strategyId}
                    </p>
                  ) : null}
                </div>

                <div className={forms.field}>
                  <label className={forms.label} htmlFor="backtest-list">
                    Stock list
                  </label>
                  <select
                    id="backtest-list"
                    className={styles.select}
                    data-testid="backtest-list"
                    value={values.stockListId}
                    disabled={loading}
                    aria-invalid={errors.stockListId !== undefined}
                    onChange={(event) =>
                      update("stockListId", event.target.value)
                    }
                  >
                    <option value="">Select a stock list…</option>
                    <OwnershipOptions items={lists} ownLabel="Your lists" />
                  </select>
                  {errors.stockListId ? (
                    <p className={forms.hint} role="alert">
                      {errors.stockListId}
                    </p>
                  ) : null}
                </div>

                <div className={forms.field}>
                  <label className={forms.label} htmlFor="backtest-benchmark">
                    Benchmark
                  </label>
                  <select
                    id="backtest-benchmark"
                    className={styles.select}
                    data-testid="backtest-benchmark"
                    value={values.benchmarkCode}
                    disabled={loading}
                    aria-invalid={errors.benchmarkCode !== undefined}
                    onChange={(event) =>
                      update("benchmarkCode", event.target.value)
                    }
                  >
                    <option value="">Select a benchmark…</option>
                    {benchmarks.map((benchmark) => (
                      <option key={benchmark.code} value={benchmark.code}>
                        {benchmark.name}
                      </option>
                    ))}
                  </select>
                  {errors.benchmarkCode ? (
                    <p className={forms.hint} role="alert">
                      {errors.benchmarkCode}
                    </p>
                  ) : (
                    <p className={forms.hint}>
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
                        update("startDate", maximumBacktestStart(new Date()))
                      }
                      title={`Earliest available start — ${BACKTEST_MAX_PERIOD_YEARS} years back`}
                    >
                      MAX
                    </button>
                  </div>
                  {errors.startDate ? (
                    <p className={forms.hint} role="alert">
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
                    onChange={(event) => update("endDate", event.target.value)}
                  />
                  {errors.endDate ? (
                    <p className={forms.hint} role="alert">
                      {errors.endDate}
                    </p>
                  ) : null}
                </div>
              </div>
            </fieldset>

            <fieldset className={styles.group}>
              <legend className={styles.groupTitle}>
                Capital and allocation
              </legend>
              <div className={styles.grid}>
                <div className={forms.field}>
                  <label className={forms.label} htmlFor="backtest-capital">
                    Initial capital
                  </label>
                  <input
                    id="backtest-capital"
                    className={forms.input}
                    data-testid="backtest-capital"
                    type="number"
                    inputMode="decimal"
                    min={BACKTEST_MIN_INITIAL_CAPITAL}
                    max={BACKTEST_MAX_INITIAL_CAPITAL}
                    step="any"
                    value={values.initialCapital}
                    aria-invalid={errors.initialCapital !== undefined}
                    onChange={(event) =>
                      update("initialCapital", event.target.value)
                    }
                  />
                  {errors.initialCapital ? (
                    <p className={forms.hint} role="alert">
                      {errors.initialCapital}
                    </p>
                  ) : null}
                </div>

                <div className={forms.field}>
                  <label
                    className={forms.label}
                    htmlFor="backtest-contribution"
                  >
                    Monthly contribution <span aria-hidden="true">·</span>{" "}
                    optional
                  </label>
                  <input
                    id="backtest-contribution"
                    className={forms.input}
                    data-testid="backtest-contribution"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={BACKTEST_MAX_MONTHLY_CONTRIBUTION}
                    step="any"
                    placeholder="0"
                    value={values.monthlyContribution}
                    aria-invalid={errors.monthlyContribution !== undefined}
                    onChange={(event) =>
                      update("monthlyContribution", event.target.value)
                    }
                  />
                  {errors.monthlyContribution ? (
                    <p className={forms.hint} role="alert">
                      {errors.monthlyContribution}
                    </p>
                  ) : (
                    <p className={forms.hint}>
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
                    onChange={(event) =>
                      update("maximumPositions", event.target.value)
                    }
                  />
                  {errors.maximumPositions ? (
                    <p className={forms.hint} role="alert">
                      {errors.maximumPositions}
                    </p>
                  ) : null}
                  <p
                    className={styles.derived}
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
            error={submitError}
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
