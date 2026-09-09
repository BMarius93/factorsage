import {
  BACKTEST_MAX_PERIOD_YEARS,
  BACKTEST_MAX_SECURITIES,
  DEFAULT_BENCHMARK_CODE,
  normalizeStrategyDefinition,
  subtractYears,
  validateStrategy,
} from "@intrinsic/contracts";
import { normalizeBuyWindowConfiguration } from "@intrinsic/domain";
import {
  QA_MATRIX_CONFIG_BEHAVIOURS,
  QA_MATRIX_EXPECTED_COMBINATIONS,
  QA_MATRIX_EXPECTED_CONFIGS,
  QA_MATRIX_EXPECTED_LISTS,
  QA_MATRIX_EXPECTED_STRATEGIES,
  QA_MATRIX_LIST_BEHAVIOURS,
  QA_MATRIX_NAME_PREFIX,
  QA_MATRIX_PLAYWRIGHT_SAMPLE,
  QA_MATRIX_SECURITIES,
  QA_MATRIX_STRATEGIES,
  QA_MATRIX_STRATEGY_BEHAVIOURS,
  STRUCTURAL_STRATEGY_BEHAVIOURS,
  CAPTURED_EXECUTION_CALENDAR_DATES,
  CAPTURED_EXECUTION_CALENDAR_SOURCE,
  QaMatrixCalendarError,
  currentAsOfDate,
  deriveStrategyBehaviours,
  isQaMatrixRun,
  qaMatrixBoundaryDates,
  qaMatrixCombinations,
  qaMatrixFixtures,
  qaMatrixPeriods,
  qaMatrixRunLabel,
} from "@intrinsic/testing";
import { ExecutionCalendar } from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import { parseCreateBacktestRunRequest } from "../backtests/backtest-requests";

/**
 * The canonical QA-MATRIX fixture definitions, checked against the **real** product contracts.
 *
 * Nothing here touches a database. What it proves is that the thousand combinations are structurally
 * submit-able before a single run exists: every Strategy passes the same `validateStrategy` the API
 * enforces, every buy-window configuration is already in the canonical persisted form, and every
 * configuration passes the same `parseCreateBacktestRunRequest` the `/backtests` route parses with.
 *
 * The DB-backed half — ownership, idempotency, exact persisted membership — is
 * `qa-matrix.integration.test.ts`.
 */
describe("QA-MATRIX fixture definitions", () => {
  // The clock the suite resolves the matrix at. `currentAsOfDate()` deliberately, not a literal:
  // the horizon assertions below are only meaningful against the horizon that is real today.
  const asOfDate = currentAsOfDate();
  // Resolved against the captured snapshot of the pinned execution-calendar series — the same rows,
  // in the same representation, that the worker hands to the simulation. Nothing here computes a
  // trading session; every session-shaped value is an index into that set.
  const fixtures = qaMatrixFixtures(asOfDate);
  const { periods, calendar } = fixtures;
  const QA_MATRIX_LISTS = fixtures.lists;
  const QA_MATRIX_CONFIGS = fixtures.configs;
  const boundaryDates = qaMatrixBoundaryDates(periods, calendar);

  const strategyIds = QA_MATRIX_STRATEGIES.map((fixture) => fixture.id);
  const listIds = QA_MATRIX_LISTS.map((fixture) => fixture.id);
  const configIds = QA_MATRIX_CONFIGS.map((fixture) => fixture.id);

  describe("shape and naming", () => {
    it("defines exactly ten strategies, ten lists and ten configurations", () => {
      expect(QA_MATRIX_STRATEGIES).toHaveLength(QA_MATRIX_EXPECTED_STRATEGIES);
      expect(QA_MATRIX_LISTS).toHaveLength(QA_MATRIX_EXPECTED_LISTS);
      expect(QA_MATRIX_CONFIGS).toHaveLength(QA_MATRIX_EXPECTED_CONFIGS);
    });

    it("numbers every fixture sequentially in its own namespace", () => {
      expect(strategyIds).toEqual([
        "S01",
        "S02",
        "S03",
        "S04",
        "S05",
        "S06",
        "S07",
        "S08",
        "S09",
        "S10",
      ]);
      expect(listIds).toEqual([
        "L01",
        "L02",
        "L03",
        "L04",
        "L05",
        "L06",
        "L07",
        "L08",
        "L09",
        "L10",
      ]);
      expect(configIds).toEqual([
        "C01",
        "C02",
        "C03",
        "C04",
        "C05",
        "C06",
        "C07",
        "C08",
        "C09",
        "C10",
      ]);
    });

    it("names every fixture in the reserved namespace with a description slug", () => {
      const named = [
        ...QA_MATRIX_STRATEGIES,
        ...QA_MATRIX_LISTS,
        ...QA_MATRIX_CONFIGS,
      ];
      for (const fixture of named) {
        expect(fixture.name).toMatch(
          new RegExp(`^${QA_MATRIX_NAME_PREFIX}(S|L|C)\\d{2}-[a-z0-9-]+$`),
        );
        expect(
          fixture.name.startsWith(`${QA_MATRIX_NAME_PREFIX}${fixture.id}-`),
        ).toBe(true);
        expect(fixture.description.length).toBeGreaterThan(0);
      }
    });

    it("keeps every name unique, so a fixture is addressable by name alone", () => {
      const names = [
        ...QA_MATRIX_STRATEGIES,
        ...QA_MATRIX_LISTS,
        ...QA_MATRIX_CONFIGS,
      ].map((fixture) => fixture.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it("cannot collide with an ordinary QA fixture: every name is namespaced", () => {
      // The lists and Stock Details suites seed `QATEST1`/`QATEST2` and create lists and strategies
      // of their own. Nothing they own begins with the reserved prefix.
      for (const fixture of [...QA_MATRIX_STRATEGIES, ...QA_MATRIX_LISTS]) {
        expect(fixture.name.startsWith(QA_MATRIX_NAME_PREFIX)).toBe(true);
      }
    });

    it("derives a run identity of the form QA-MATRIX-Sxx-Lxx-Cxx", () => {
      expect(qaMatrixRunLabel("S04", "L09", "C06")).toBe(
        "QA-MATRIX-S04-L09-C06",
      );
    });
  });

  describe("strategies", () => {
    it("passes the real strategy validation contract", () => {
      for (const fixture of QA_MATRIX_STRATEGIES) {
        const issues = validateStrategy({
          name: fixture.name,
          description: fixture.description,
          definition: fixture.definition,
        });
        expect(issues, `${fixture.name}: ${JSON.stringify(issues)}`).toEqual(
          [],
        );
      }
    });

    it("round-trips through canonical normalization unchanged", () => {
      // The seeder persists the normalized document and the read path normalizes it again. A
      // fixture that is not already canonical would be stored as something other than what this
      // file says it is.
      for (const fixture of QA_MATRIX_STRATEGIES) {
        const once = normalizeStrategyDefinition(fixture.definition);
        expect(once).toEqual(fixture.definition);
        expect(normalizeStrategyDefinition(once)).toEqual(fixture.definition);
      }
    });

    it("uses deterministic positional row ids, never a generated identifier", () => {
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const fixture of QA_MATRIX_STRATEGIES) {
        const ids: string[] = [];
        const collect = (signal: {
          conditions: { id: string }[];
          trigger?: { id: string };
        }) => {
          for (const condition of signal.conditions) {
            ids.push(condition.id);
          }
          if (signal.trigger) {
            ids.push(signal.trigger.id);
          }
        };
        for (const level of [
          ...fixture.definition.buyLevels,
          ...fixture.definition.sellLevels,
        ]) {
          ids.push(level.id);
          collect(level.signal);
        }
        if (fixture.definition.finalExit) {
          ids.push(fixture.definition.finalExit.id);
          collect(fixture.definition.finalExit.signal);
        }
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) {
          expect(id).not.toMatch(uuid);
          expect(id.startsWith(fixture.id.toLowerCase())).toBe(true);
        }
      }
    });

    it("claims exactly the structural behaviours its definition contains", () => {
      const structural = new Set<string>(STRUCTURAL_STRATEGY_BEHAVIOURS);
      for (const fixture of QA_MATRIX_STRATEGIES) {
        const derived = [
          ...deriveStrategyBehaviours(fixture.definition),
        ].sort();
        const claimed = fixture.behaviours
          .filter((tag) => structural.has(tag))
          .sort();
        expect(claimed, fixture.name).toEqual(derived);
      }
    });

    it("covers every intended Backtest V1 behaviour at least once", () => {
      const covered = new Set(
        QA_MATRIX_STRATEGIES.flatMap((fixture) => fixture.behaviours),
      );
      for (const behaviour of QA_MATRIX_STRATEGY_BEHAVIOURS) {
        expect(
          covered.has(behaviour),
          `no strategy exercises ${behaviour}`,
        ).toBe(true);
      }
    });
  });

  describe("lists", () => {
    it("references only securities in the matrix catalog universe, and uses all of them", () => {
      const universe = new Set(
        QA_MATRIX_SECURITIES.map((security) => security.symbol),
      );
      const referenced = new Set(
        QA_MATRIX_LISTS.flatMap((fixture) =>
          fixture.members.map((member) => member.symbol),
        ),
      );
      for (const symbol of referenced) {
        expect(
          universe.has(symbol),
          `${symbol} is outside the matrix universe`,
        ).toBe(true);
      }
      // An unused security would be a fixture nobody exercises, kept alive by nothing.
      expect([...universe].filter((symbol) => !referenced.has(symbol))).toEqual(
        [],
      );
    });

    it("keeps every membership within one list unique", () => {
      for (const fixture of QA_MATRIX_LISTS) {
        const symbols = fixture.members.map((member) => member.symbol);
        expect(new Set(symbols).size, fixture.name).toBe(symbols.length);
      }
    });

    it("stays inside the backtest submission's security cap", () => {
      for (const fixture of QA_MATRIX_LISTS) {
        expect(fixture.members.length).toBeGreaterThan(0);
        expect(fixture.members.length).toBeLessThanOrEqual(
          BACKTEST_MAX_SECURITIES,
        );
      }
    });

    it("states every buy window in its canonical persisted form already", () => {
      for (const fixture of QA_MATRIX_LISTS) {
        for (const member of fixture.members) {
          const canonical = normalizeBuyWindowConfiguration({
            mode: member.mode,
            ranges: member.ranges,
          });
          expect(canonical.mode, `${fixture.name}/${member.symbol}`).toBe(
            member.mode,
          );
          expect(canonical.ranges, `${fixture.name}/${member.symbol}`).toEqual(
            member.ranges,
          );
        }
      }
    });

    it("persists zero ranges for FULL and at least one for CUSTOM", () => {
      for (const fixture of QA_MATRIX_LISTS) {
        for (const member of fixture.members) {
          if (member.mode === "FULL") {
            expect(member.ranges, `${fixture.name}/${member.symbol}`).toEqual(
              [],
            );
          } else {
            expect(
              member.ranges.length,
              `${fixture.name}/${member.symbol}`,
            ).toBeGreaterThan(0);
          }
        }
      }
    });

    describe("L10 execution-date boundaries", () => {
      const l10 = QA_MATRIX_LISTS.find((fixture) => fixture.id === "L10")!;
      const endpoints = l10.members.flatMap((member) =>
        member.ranges.flatMap((range) => [
          range.startDate,
          range.endDate as string,
        ]),
      );

      it("puts every executable endpoint in the authoritative execution-date set", () => {
        // The assertion the whole refactor exists for. Membership is decided by the pinned
        // execution-calendar series' own bars — the matrix has no rule of its own to consult, and
        // an endpoint the engine would never simulate cannot get through here.
        for (const member of l10.members) {
          for (const range of member.ranges) {
            expect(range.endDate).not.toBeNull();
            expect(
              calendar.has(range.startDate),
              `${member.symbol} opens on ${range.startDate}, which is not an execution date`,
            ).toBe(true);
            expect(
              calendar.has(range.endDate as string),
              `${member.symbol} closes on ${range.endDate}, which is not an execution date`,
            ).toBe(true);
          }
        }
        expect(endpoints.length).toBe(14);
      });

      it("never leaves a window empty of execution dates", () => {
        // The failure this catches is a window that is non-empty on the calendar and empty in the
        // simulation, which would make the fixture silently untestable rather than visibly wrong.
        for (const member of l10.members) {
          for (const range of member.ranges) {
            const simulated = calendar.dates.filter(
              (date) =>
                date >= range.startDate && date <= (range.endDate as string),
            );
            expect(
              simulated.length,
              `${member.symbol} ${range.startDate}..${range.endDate} contains no execution date`,
            ).toBeGreaterThan(0);
          }
        }
      });

      it("opens one window on the first execution date of the longest run", () => {
        const jnj = l10.members.find((member) => member.symbol === "JNJ")!;
        expect(jnj.ranges[0]!.startDate).toBe(
          periods.thirtyYear.firstExecutionDate,
        );
        expect(jnj.ranges[0]!.startDate).toBe(boundaryDates.firstExecutionDate);
        // And it is genuinely the calendar's own first date at or after the product horizon.
        expect(calendar.onOrAfter(periods.horizonStart)).toBe(
          jnj.ranges[0]!.startDate,
        );
      });

      it("closes one window on the exact last execution date", () => {
        const ko = l10.members.find((member) => member.symbol === "KO")!;
        expect(ko.ranges[0]!.endDate).toBe(periods.periodEnd);
        expect(calendar.advance(periods.periodEnd, 1)).toBeUndefined();
      });

      it("opens one window on the next execution date after its run begins", () => {
        const msft = l10.members.find((member) => member.symbol === "MSFT")!;
        const open = periods.tenYear.firstExecutionDate;
        expect(msft.ranges[0]!.startDate).toBe(calendar.advance(open, 1));
        // Exactly one execution date is excluded — the run's opening date — and nothing else.
        expect(calendar.positionOf(msft.ranges[0]!.startDate)).toBe(
          calendar.positionOf(open) + 1,
        );
      });

      it("closes one window on the execution date immediately before a later one", () => {
        const ibm = l10.members.find((member) => member.symbol === "IBM")!;
        const oneYearOpen = periods.oneYear.firstExecutionDate;
        expect(ibm.ranges[0]!.endDate).toBe(calendar.advance(oneYearOpen, -1));
        expect(calendar.positionOf(ibm.ranges[0]!.endDate as string)).toBe(
          calendar.positionOf(oneYearOpen) - 1,
        );
      });

      it("holds exactly one execution date in the single-session window", () => {
        const xom = l10.members.find((member) => member.symbol === "XOM")!;
        const range = xom.ranges[0]!;
        expect(range.startDate).toBe(range.endDate);
        expect(
          calendar.dates.filter(
            (date) =>
              date >= range.startDate && date <= (range.endDate as string),
          ),
        ).toEqual([range.startDate]);
        // Inside the shortest configuration, so every configuration reaches it.
        expect(range.startDate >= periods.oneYear.startDate).toBe(true);
        expect(range.startDate <= periods.periodEnd).toBe(true);
      });

      it("straddles a year boundary with an execution date represented on each side", () => {
        const cat = l10.members.find((member) => member.symbol === "CAT")!;
        const yearEnd = boundaryDates.yearEndExecutionDate;
        const yearStart = boundaryDates.yearStartExecutionDate;

        // Different calendar years, and consecutive execution dates: the engine simulates nothing
        // between them.
        expect(yearEnd.slice(0, 4)).not.toBe(yearStart.slice(0, 4));
        expect(calendar.advance(yearEnd, 1)).toBe(yearStart);
        expect(calendar.lastOfYear(Number(yearEnd.slice(0, 4)))).toBe(yearEnd);
        expect(calendar.firstOfYear(Number(yearStart.slice(0, 4)))).toBe(
          yearStart,
        );

        // The window covers exactly those two execution dates and nothing else.
        const covered = calendar.dates.filter((date) =>
          cat.ranges.some(
            (range) =>
              date >= range.startDate && date <= (range.endDate as string),
          ),
        );
        expect(covered).toEqual([yearEnd, yearStart]);

        // Whether that is one range or two is decided by the calendar, not by the fixture: two
        // sessions across a normal 1 January are not calendar-adjacent and stay separate, while a
        // calendar carrying a bar on 1 January makes them adjacent and the normalizer merges them.
        const adjacent =
          new Date(`${yearEnd}T00:00:00.000Z`).valueOf() + 86_400_000 ===
          new Date(`${yearStart}T00:00:00.000Z`).valueOf();
        expect(cat.ranges).toHaveLength(adjacent ? 1 : 2);
        expect(cat.ranges[0]!.startDate).toBe(yearEnd);
        expect(cat.ranges[cat.ranges.length - 1]!.endDate).toBe(yearStart);

        expect(yearEnd >= periods.oneYear.startDate).toBe(true);
      });

      it("moves with the calendar, not with a rule of its own", () => {
        // Drop three sessions from the tail of the authoritative set and the fixtures follow it.
        // A matrix that computed sessions from holiday rules could not do this, and would keep
        // naming a date the engine no longer simulates.
        const shortened = CAPTURED_EXECUTION_CALENDAR_DATES.slice(0, -3);
        const trimmed = qaMatrixFixtures(asOfDate, shortened);
        expect(trimmed.periods.periodEnd).toBe(shortened[shortened.length - 1]);
        expect(trimmed.periods.periodEnd).not.toBe(periods.periodEnd);
        const trimmedKo = trimmed.lists
          .find((fixture) => fixture.id === "L10")!
          .members.find((member) => member.symbol === "KO")!;
        expect(trimmedKo.ranges[0]!.endDate).toBe(trimmed.periods.periodEnd);
      });
    });

    describe("the authoritative execution-date set", () => {
      it("is the pinned execution-calendar series, captured, not a computed calendar", () => {
        expect(CAPTURED_EXECUTION_CALENDAR_SOURCE).toEqual({
          benchmarkCode: "SP500",
          seriesVersion: 1,
          providerSymbol: "SPY",
        });
        expect(CAPTURED_EXECUTION_CALENDAR_DATES.length).toBeGreaterThan(7_000);
      });

      it("is ascending, unique and made only of calendar dates", () => {
        const dates = CAPTURED_EXECUTION_CALENDAR_DATES;
        expect(new Set(dates).size).toBe(dates.length);
        expect([...dates].sort()).toEqual([...dates]);
        for (const date of dates) {
          expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      });

      it("refuses to resolve a matrix against a calendar that cannot support it", () => {
        expect(() => qaMatrixFixtures(asOfDate, [])).toThrow(
          QaMatrixCalendarError,
        );
        // A calendar that stops decades before the clock cannot answer where the periods begin.
        expect(() =>
          qaMatrixFixtures(asOfDate, ["1998-01-02", "1998-01-05"]),
        ).toThrow(QaMatrixCalendarError);
      });

      it("reads a date as an execution date only because the set contains it", () => {
        // The calendar has no notion of weekends or holidays: hand it a Sunday and it is a session.
        const invented = new ExecutionCalendar(["2026-09-06", "2026-09-07"]);
        expect(invented.has("2026-09-06")).toBe(true);
        expect(invented.has("2026-09-08")).toBe(false);
        expect(invented.advance("2026-09-06", 1)).toBe("2026-09-07");
      });
    });

    it("covers every intended universe and buy-window behaviour at least once", () => {
      const covered = new Set(
        QA_MATRIX_LISTS.flatMap((fixture) => fixture.behaviours),
      );
      for (const behaviour of QA_MATRIX_LIST_BEHAVIOURS) {
        expect(covered.has(behaviour), `no list exercises ${behaviour}`).toBe(
          true,
        );
      }
    });

    it("sizes the universe fixtures the way their behaviour tags claim", () => {
      const sizeOf = (id: string) =>
        QA_MATRIX_LISTS.find((fixture) => fixture.id === id)?.members.length ??
        0;
      expect(sizeOf("L01")).toBe(1);
      // The large list is Dow-sized: the intended V1 usage, well inside the 200-security cap.
      expect(sizeOf("L08")).toBe(30);
      for (const fixture of QA_MATRIX_LISTS) {
        if (fixture.behaviours.includes("SMALL_UNIVERSE")) {
          expect(fixture.members.length, fixture.name).toBeLessThanOrEqual(4);
        }
        if (fixture.behaviours.includes("MEDIUM_UNIVERSE")) {
          expect(fixture.members.length, fixture.name).toBeGreaterThanOrEqual(
            5,
          );
          expect(fixture.members.length, fixture.name).toBeLessThanOrEqual(8);
        }
      }
    });
  });

  describe("configurations", () => {
    it("passes the real backtest submission validation contract", () => {
      for (const fixture of QA_MATRIX_CONFIGS) {
        const parsed = parseCreateBacktestRunRequest({
          strategyId: "00000000-0000-4000-8000-000000000001",
          stockListId: "00000000-0000-4000-8000-000000000002",
          ...fixture.request,
        });
        expect(parsed.startDate).toBe(fixture.request.startDate);
        expect(parsed.endDate).toBe(fixture.request.endDate);
        expect(parsed.initialCapital).toBe(fixture.request.initialCapital);
        expect(parsed.monthlyContribution).toBe(
          fixture.request.monthlyContribution,
        );
        expect(parsed.maximumPositions).toBe(fixture.request.maximumPositions);
      }
    });

    it("shares one end date, which is a real trading session and never in the future", () => {
      for (const fixture of QA_MATRIX_CONFIGS) {
        expect(fixture.request.endDate).toBe(periods.periodEnd);
        expect(fixture.request.startDate < fixture.request.endDate).toBe(true);
        expect(fixture.request.endDate <= asOfDate).toBe(true);
      }
      // A run's last date being an execution date is what lets `L10` close a window exactly on it.
      expect(calendar.has(periods.periodEnd)).toBe(true);
    });

    it("never starts before the product horizon for its clock", () => {
      // `projectionRange` clips a request to `[today - STOCK_HISTORY_YEARS, today]` **silently**.
      // A start older than the horizon is therefore not rejected — it is quietly shortened, and the
      // run reports a period it did not simulate. That is the failure this asserts away.
      for (const fixture of QA_MATRIX_CONFIGS) {
        expect(
          fixture.request.startDate >= periods.horizonStart,
          `${fixture.name} starts ${fixture.request.startDate}, before the horizon ${periods.horizonStart}`,
        ).toBe(true);
      }
    });

    it("starts the thirty-year configurations exactly at the product horizon", () => {
      // Derived from the canonical primitives rather than read back from the clock module, so the
      // assertion is against the product's own rule and not against the code under test.
      const horizon = subtractYears(asOfDate, BACKTEST_MAX_PERIOD_YEARS);
      expect(periods.horizonStart).toBe(horizon);

      const thirtyYear = QA_MATRIX_CONFIGS.filter((fixture) =>
        fixture.behaviours.includes("STARTS_AT_PRODUCT_HORIZON"),
      );
      expect(thirtyYear.map((fixture) => fixture.id)).toEqual([
        "C01",
        "C08",
        "C10",
      ]);
      for (const fixture of thirtyYear) {
        expect(fixture.request.startDate, fixture.name).toBe(horizon);
      }
    });

    it("moves with the clock instead of rotting into an out-of-horizon request", () => {
      // The same matrix resolved a year later must still start exactly at the horizon, which a
      // hard-coded start could not do.
      const later = "2027-04-15";
      const laterConfigs = qaMatrixFixtures(later).configs;
      const laterHorizon = subtractYears(later, BACKTEST_MAX_PERIOD_YEARS);
      for (const fixture of laterConfigs) {
        expect(fixture.request.startDate >= laterHorizon).toBe(true);
        expect(fixture.request.endDate <= later).toBe(true);
      }
      expect(
        laterConfigs.find((fixture) => fixture.id === "C01")?.request.startDate,
      ).toBe(laterHorizon);
    });

    it("is a pure function of its clock", () => {
      expect(qaMatrixFixtures("2026-03-02").configs).toEqual(
        qaMatrixFixtures("2026-03-02").configs,
      );
      expect(qaMatrixFixtures("2026-03-02").lists).toEqual(
        qaMatrixFixtures("2026-03-02").lists,
      );
    });

    /**
     * A calendar with a bar on every calendar day, used only to isolate the clock's year
     * arithmetic.
     *
     * It is deliberately not a market: nothing in the matrix decides what a session is, so the way
     * to test the arithmetic *without* a calendar's own gaps interfering is to hand it a set with
     * no gaps at all. Every other test in this file uses the captured authoritative set.
     */
    const denseCalendar = (from: string, to: string): ExecutionCalendar => {
      const dates: string[] = [];
      for (
        let time = Date.parse(`${from}T00:00:00.000Z`);
        time <= Date.parse(`${to}T00:00:00.000Z`);
        time += 86_400_000
      ) {
        dates.push(new Date(time).toISOString().slice(0, 10));
      }
      return new ExecutionCalendar(dates);
    };

    it("survives a leap-day clock, where the horizon and the period cap disagree", () => {
      // `subtractYears` clamps 29 February to the 28th; the submission validator's own year
      // arithmetic is a plain `setUTCFullYear` and does not. On that one day the validator's cap
      // lands a day before the clock, so a period end taken naively from the clock would be
      // rejected by the endpoint the matrix has to pass. The clock clamps the end instead of the
      // start, because the start is the horizon and moving it would defeat the point.
      const dense = denseCalendar("1996-01-01", "2028-12-31");
      const leap = qaMatrixPeriods("2028-02-29", dense);
      expect(leap.horizonStart).toBe("1998-02-28");
      // 29 February is in this calendar, so only the cap can be what excluded it.
      expect(dense.has("2028-02-29")).toBe(true);
      expect(leap.periodEnd).toBe("2028-02-28");
    });

    it("keeps every clock's thirty-year period inside the validator's own period cap", () => {
      // The validator's arithmetic, reproduced exactly: `endDate > addYears(startDate, 30)` is a
      // rejection, and `addYears` here is the plain shift the API uses, not the clamping one.
      const apiAddYears = (date: string, years: number): string => {
        const shifted = new Date(`${date}T00:00:00.000Z`);
        shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
        return shifted.toISOString().slice(0, 10);
      };
      const dense = denseCalendar("1996-01-01", "2029-12-31");
      // Well over a year of consecutive clocks, so leap days and month ends are all covered rather
      // than argued about.
      for (let offset = 0; offset < 420; offset += 1) {
        const clock = new Date(Date.UTC(2028, 0, 1) + offset * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const derived = qaMatrixPeriods(clock, dense);
        expect(
          derived.thirtyYear.endDate <=
            apiAddYears(
              derived.thirtyYear.startDate,
              BACKTEST_MAX_PERIOD_YEARS,
            ),
          `clock ${clock}: ${derived.thirtyYear.startDate}..${derived.thirtyYear.endDate} exceeds the period cap`,
        ).toBe(true);
        expect(derived.thirtyYear.startDate).toBe(
          subtractYears(clock, BACKTEST_MAX_PERIOD_YEARS),
        );
        expect(derived.periodEnd <= clock).toBe(true);
        expect(dense.has(derived.periodEnd)).toBe(true);
      }
    });

    it("never simulates past the last date its execution calendar holds", () => {
      // Not staleness to patch around: a run cannot simulate a date the calendar does not have, so
      // an older capture simply yields an earlier period end, and the fixtures stay consistent.
      const truncated = CAPTURED_EXECUTION_CALENDAR_DATES.slice(0, -10);
      const derived = qaMatrixPeriods(
        asOfDate,
        new ExecutionCalendar(truncated),
      );
      expect(derived.periodEnd).toBe(truncated[truncated.length - 1]);
      expect(derived.periodEnd < asOfDate).toBe(true);
    });

    it("covers 1, 5, 10, 20 and 30 position slots", () => {
      const slots = new Set(
        QA_MATRIX_CONFIGS.map((fixture) => fixture.request.maximumPositions),
      );
      expect([...slots].sort((left, right) => left - right)).toEqual([
        1, 5, 10, 20, 30,
      ]);
    });

    it("covers 1, 5, 10, 20 and 30 position slots", () => {
      const slots = new Set(
        QA_MATRIX_CONFIGS.map((fixture) => fixture.request.maximumPositions),
      );
      expect([...slots].sort((left, right) => left - right)).toEqual([
        1, 5, 10, 20, 30,
      ]);
    });

    it("keeps every period inside the thirty-year product horizon", () => {
      for (const fixture of QA_MATRIX_CONFIGS) {
        const limit = new Date(`${fixture.request.startDate}T00:00:00.000Z`);
        limit.setUTCFullYear(
          limit.getUTCFullYear() + BACKTEST_MAX_PERIOD_YEARS,
        );
        expect(
          fixture.request.endDate <= limit.toISOString().slice(0, 10),
        ).toBe(true);
      }
    });

    it("holds benchmark and calendar semantics constant across the matrix", () => {
      for (const fixture of QA_MATRIX_CONFIGS) {
        expect(fixture.request.benchmarkCode).toBe(DEFAULT_BENCHMARK_CODE);
      }
    });

    it("covers every intended execution behaviour at least once", () => {
      const covered = new Set(
        QA_MATRIX_CONFIGS.flatMap((fixture) => fixture.behaviours),
      );
      for (const behaviour of QA_MATRIX_CONFIG_BEHAVIOURS) {
        expect(
          covered.has(behaviour),
          `no configuration exercises ${behaviour}`,
        ).toBe(true);
      }
    });
  });

  describe("the matrix itself", () => {
    it("is exactly one thousand structurally submit-able combinations", () => {
      const combinations = qaMatrixCombinations();
      expect(combinations).toHaveLength(QA_MATRIX_EXPECTED_COMBINATIONS);
      expect(
        QA_MATRIX_STRATEGIES.length *
          QA_MATRIX_LISTS.length *
          QA_MATRIX_CONFIGS.length,
      ).toBe(QA_MATRIX_EXPECTED_COMBINATIONS);

      const labels = new Set<string>();
      for (const combination of combinations) {
        expect(labels.has(combination.label)).toBe(false);
        labels.add(combination.label);
        // Structurally submit-able: the strategy validates, the list is a usable universe, and the
        // configuration parses — everything the API checks before a run row exists.
        expect(
          validateStrategy({
            name: combination.strategy.name,
            description: combination.strategy.description,
            definition: combination.strategy.definition,
          }),
        ).toEqual([]);
        expect(combination.list.members.length).toBeGreaterThan(0);
        expect(combination.list.members.length).toBeLessThanOrEqual(
          BACKTEST_MAX_SECURITIES,
        );
        expect(() =>
          parseCreateBacktestRunRequest({
            strategyId: "00000000-0000-4000-8000-000000000001",
            stockListId: "00000000-0000-4000-8000-000000000002",
            ...combination.config.request,
          }),
        ).not.toThrow();
      }
      expect(labels.size).toBe(QA_MATRIX_EXPECTED_COMBINATIONS);
    });

    it("enumerates in a stable order, so a partial matrix resumes at a known index", () => {
      const first = qaMatrixCombinations().map(
        (combination) => combination.label,
      );
      const second = qaMatrixCombinations().map(
        (combination) => combination.label,
      );
      expect(second).toEqual(first);
      expect(first[0]).toBe("QA-MATRIX-S01-L01-C01");
      expect(first[first.length - 1]).toBe("QA-MATRIX-S10-L10-C10");
    });
  });

  describe("run retention", () => {
    it("recognizes a matrix run from the columns a run keeps forever", () => {
      expect(
        isQaMatrixRun({
          strategyName: QA_MATRIX_STRATEGIES[0]!.name,
          stockListName: QA_MATRIX_LISTS[0]!.name,
        }),
      ).toBe(true);
    });

    it("never claims an ordinary backtest, including one that used a matrix fixture by halves", () => {
      expect(
        isQaMatrixRun({
          strategyName: "My value strategy",
          stockListName: "Dow Jones",
        }),
      ).toBe(false);
      // A matrix strategy run against a personal list is a developer's own run, not matrix output.
      expect(
        isQaMatrixRun({
          strategyName: QA_MATRIX_STRATEGIES[0]!.name,
          stockListName: "Dow Jones",
        }),
      ).toBe(false);
      expect(
        isQaMatrixRun({
          strategyName: "My value strategy",
          stockListName: QA_MATRIX_LISTS[0]!.name,
        }),
      ).toBe(false);
    });
  });

  describe("Playwright support", () => {
    it("names a small representative sample of real combinations", () => {
      // Small on purpose: the thousand-run sweep is backend work, and a browser adds nothing to it.
      expect(QA_MATRIX_PLAYWRIGHT_SAMPLE.length).toBeLessThanOrEqual(5);
      for (const sample of QA_MATRIX_PLAYWRIGHT_SAMPLE) {
        expect(strategyIds).toContain(sample.strategyId);
        expect(listIds).toContain(sample.listId);
        expect(configIds).toContain(sample.configId);
        expect(sample.reason.length).toBeGreaterThan(0);
      }
    });
  });

  describe("securities", () => {
    it("uses real catalog identities on supported exchanges", () => {
      for (const security of QA_MATRIX_SECURITIES) {
        // Real US tickers are at most five characters. The deliberately fictional `QATEST*` rows
        // are seven, precisely so catalog synchronization can never reclaim them; these are the
        // opposite kind of fixture and must look exactly like the catalog rows they are.
        expect(security.symbol.length).toBeLessThanOrEqual(5);
        expect(["NASDAQ", "NYSE"]).toContain(security.exchangeCode);
        expect(security.currency).toBe("USD");
        expect(security.type).toBe("STOCK");
        expect(security.listedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      const symbols = QA_MATRIX_SECURITIES.map((security) => security.symbol);
      expect(new Set(symbols).size).toBe(symbols.length);
    });

    it("labels listing coverage against the thirty-year horizon consistently", () => {
      const horizonStart = QA_MATRIX_CONFIGS.find(
        (config) => config.id === "C01",
      )!.request.startDate;
      for (const security of QA_MATRIX_SECURITIES) {
        const expected =
          security.listedOn < horizonStart ? "FULL_HORIZON" : "LATER_LISTING";
        expect(security.coverage, security.symbol).toBe(expected);
      }
    });

    it("has both a full-horizon and a later-listing group to build lists from", () => {
      const byCoverage = (value: string) =>
        QA_MATRIX_SECURITIES.filter((security) => security.coverage === value);
      expect(byCoverage("FULL_HORIZON").length).toBeGreaterThanOrEqual(25);
      expect(byCoverage("LATER_LISTING").length).toBeGreaterThanOrEqual(5);
    });
  });
});
