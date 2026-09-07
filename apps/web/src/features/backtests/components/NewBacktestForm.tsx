"use client";

import {
  BACKTEST_MAX_INITIAL_CAPITAL,
  BACKTEST_MAX_MAXIMUM_POSITIONS,
  BACKTEST_MAX_MONTHLY_CONTRIBUTION,
  BACKTEST_MIN_INITIAL_CAPITAL,
  BACKTEST_MIN_MAXIMUM_POSITIONS,
  DEFAULT_BENCHMARK_CODE,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import forms from "../../../components/ui/forms.module.css";
import { ApiError } from "../../../lib/api/client";
import { createBacktestRun } from "../api/backtests-api";
import { useBacktestOptions } from "../hooks/use-backtest-options";
import {
  defaultBacktestPeriod,
  fullPositionHelpText,
  validateBacktestForm,
  type BacktestFormErrors,
  type BacktestFormValues,
} from "../utils/submission";
import styles from "./NewBacktestForm.module.css";

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
  // The API validates the same document again; when it disagrees its product-vocabulary message is
  // what the user needs to read, not a generic banner.
  if (error instanceof ApiError && error.status === 400) {
    return error.message;
  }
  return "The backtest could not be submitted right now. Try again in a moment.";
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

  if (status === "error") {
    return (
      <PageContainer>
        <div className={styles.page}>
          <div className={styles.statusPanel} role="alert">
            <h1 className={styles.statusTitle}>
              The submission form could not be loaded
            </h1>
            <p className={styles.statusBody}>
              Your strategies, lists and benchmarks are needed before a backtest
              can be submitted. This is usually temporary.
            </p>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={retry}
            >
              Try again
            </button>
          </div>
        </div>
      </PageContainer>
    );
  }

  const loading = status === "loading";
  const missingPrerequisite =
    status === "ready" && (strategies.length === 0 || lists.length === 0);

  return (
    <PageContainer>
      <div className={styles.page} data-testid="new-backtest-page">
        <div className={styles.breadcrumb}>
          <Link className={styles.backLink} href="/backtests">
            ← Backtests
          </Link>
        </div>

        <header className={styles.header}>
          <h1 className={styles.title}>New backtest</h1>
          <p className={styles.lead}>
            One strategy, one stock list, one historical period. The run
            executes in the background and its results appear while it
            progresses.
          </p>
        </header>

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
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>What to run</h2>
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
                  onChange={(event) => update("strategyId", event.target.value)}
                >
                  <option value="">Select a strategy…</option>
                  {strategies.map((strategy) => (
                    <option key={strategy.id} value={strategy.id}>
                      {strategy.name}
                    </option>
                  ))}
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
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name}
                    </option>
                  ))}
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
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Period</h2>
            <div className={styles.grid}>
              <div className={forms.field}>
                <label className={forms.label} htmlFor="backtest-start">
                  Start date
                </label>
                <input
                  id="backtest-start"
                  className={forms.input}
                  data-testid="backtest-start"
                  type="date"
                  value={values.startDate}
                  aria-invalid={errors.startDate !== undefined}
                  onChange={(event) => update("startDate", event.target.value)}
                />
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
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Capital and allocation</h2>
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
                <label className={forms.label} htmlFor="backtest-contribution">
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
                <label className={forms.label} htmlFor="backtest-max-positions">
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
                <p className={styles.derived} data-testid="full-position-help">
                  {helpText}
                </p>
              </div>
            </div>
          </div>

          {submitError ? (
            <p
              className={forms.error}
              role="alert"
              data-testid="backtest-submit-error"
            >
              {submitError}
            </p>
          ) : null}

          <div className={forms.actions}>
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
          </div>
        </form>
      </div>
    </PageContainer>
  );
}
