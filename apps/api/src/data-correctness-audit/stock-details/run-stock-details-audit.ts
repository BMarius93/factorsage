import type { PrismaClient } from "@intrinsic/database";
import type { AuditWriter } from "../artifacts";
import { ComparisonLedger } from "../comparison";
import { INDICATORS } from "../oracle/indicators";
import {
  dailyValuations,
  type BlendId,
  type ModelId,
} from "../oracle/intrinsic";
import { readStatements } from "../intrinsic/run-intrinsic-audit";
import {
  TECHNICAL_TOLERANCE,
  referenceForSecurity,
  type SecurityIndicators,
} from "../technicals/run-technicals-audit";
import { AUDIT_API } from "../ui/audit-stack";

/**
 * Stock Details: persisted rows and reference series against `GET /stocks/:symbol`, for a symbol
 * set chosen for its differences rather than at random. The same expectations, formatted, are what
 * the browser stage checks on the page.
 */

export const STOCK_DETAIL_SYMBOLS: readonly { symbol: string; why: string }[] =
  [
    {
      symbol: "KO",
      why: "long-history large cap, dividend payer (DDM and the Dividend blend available)",
    },
    {
      symbol: "AAPL",
      why: "split history (7:1 2014, 4:1 2020); long price history",
    },
    { symbol: "NVDA", why: "split history (4:1 2021, 10:1 2024)" },
    {
      symbol: "MRNA",
      why: "newer listing (2018), short history, recent losses (Graham/RI unavailable)",
    },
    {
      symbol: "AMZN",
      why: "no common dividend (DDM and the Dividend blend unavailable)",
    },
    {
      symbol: "DIS",
      why: "provider filing dates equal to period ends before 2019 (look-ahead finding)",
    },
    { symbol: "V", why: "listing inside the horizon (2008)" },
    { symbol: "GOOGL", why: "splits and a reporting-entity change in 2015" },
    {
      symbol: "CRM",
      why: "initiated a dividend in 2024 (DDM availability changes)",
    },
    { symbol: "XOM", why: "energy cyclicality: negative earnings in 2020" },
  ];

const MODEL_IDS: ModelId[] = ["DCF_FCFF", "RESIDUAL_INCOME", "DDM", "GRAHAM"];
const BLEND_IDS: BlendId[] = ["BALANCED", "CONSERVATIVE", "DIVIDEND"];

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function minusOneYear(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const candidate = new Date(Date.UTC(year - 1, month - 1, day));
  // 29 February one year back clamps to the 28th, as calendar subtraction does.
  if (candidate.getUTCMonth() !== month - 1) {
    candidate.setUTCDate(0);
  }
  return candidate.toISOString().slice(0, 10);
}

export async function runStockDetailsSection(input: {
  prisma: PrismaClient;
  writer: AuditWriter;
  log: (line: string) => void;
  technicals: ReadonlyMap<string, SecurityIndicators> | null;
  asOf: string;
}): Promise<{ ledger: ComparisonLedger; detail: Record<string, unknown> }> {
  const { prisma, writer } = input;
  const ledger = new ComparisonLedger(300);
  const to = localToday();
  const from = minusOneYear(to);
  const uiExpectations: Record<string, unknown>[] = [];
  const perSymbol: Record<string, unknown> = {};

  for (const { symbol, why } of STOCK_DETAIL_SYMBOLS) {
    const security = (
      await prisma.$queryRawUnsafe<
        { id: string; ipoDate: string | null; currency: string }[]
      >(
        `select id, "ipoDate"::text as "ipoDate", currency from "Security" where symbol = $1 and "exchangeCode" in ('NASDAQ','NYSE')`,
        symbol,
      )
    )[0];
    if (!security) {
      ledger.skip("stock-details", symbol, "not in the catalog");
      continue;
    }
    const response = await fetch(
      `${AUDIT_API}/stocks/${symbol}?from=${from}&to=${to}`,
    );
    ledger.check(
      "stock-details",
      `${symbol} HTTP status`,
      200,
      response.status,
      "exact-number",
    );
    if (!response.ok) {
      continue;
    }
    const body = (await response.json()) as {
      prices: {
        date: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }[];
      technicals: (Record<string, number | undefined> & { date: string })[];
      intrinsicValues: {
        valuationDate: string;
        model: ModelId;
        valuePerShare: number;
        sourceDataAsOf: string;
      }[];
      intrinsicValueBlends: {
        valuationDate: string;
        blendId: BlendId;
        valuePerShare: number;
      }[];
    };

    // Prices: every served bar is the persisted bar, and every persisted bar in the window is served.
    const bars = await prisma.$queryRawUnsafe<
      {
        date: string;
        open: string;
        high: string;
        low: string;
        close: string;
        volume: string;
      }[]
    >(
      `select date::text as date, open::text as open, high::text as high, low::text as low, close::text as close, volume::text as volume
         from "DailyPrice" where "securityId" = $1 and date between $2::date and $3::date order by date`,
      security.id,
      from,
      to,
    );
    ledger.check(
      "stock-details-prices",
      `${symbol} bar count`,
      bars.length,
      body.prices.length,
      "exact-number",
    );
    bars.forEach((bar, index) => {
      const served = body.prices[index];
      ledger.check(
        "stock-details-prices",
        `${symbol} ${bar.date} OHLCV`,
        JSON.stringify([
          bar.date,
          Number(bar.open),
          Number(bar.high),
          Number(bar.low),
          Number(bar.close),
          Number(bar.volume),
        ]),
        served
          ? JSON.stringify([
              served.date,
              served.open,
              served.high,
              served.low,
              served.close,
              served.volume,
            ])
          : "missing",
        "exact-text",
      );
    });

    // Technicals: every served value against the reference series recomputed from closes.
    const reference =
      input.technicals?.get(security.id) ??
      (await referenceForSecurity(
        prisma,
        security.id,
        security.ipoDate,
        input.asOf,
      ));
    const index = new Map(
      reference.dates.map((date, position) => [date, position]),
    );
    let technicalValues = 0;
    for (const row of body.technicals) {
      const position = index.get(row.date);
      for (const indicator of INDICATORS) {
        const expected =
          position === undefined
            ? null
            : (reference.values.get(indicator.column)![position] ?? null);
        const served = row[indicator.column] ?? null;
        technicalValues += 1;
        if (expected === null || served === null) {
          ledger.check(
            "stock-details-technicals",
            `${symbol} ${row.date} ${indicator.column}`,
            expected,
            served,
            "exact-number",
          );
        } else {
          ledger.check(
            "stock-details-technicals",
            `${symbol} ${row.date} ${indicator.column}`,
            expected,
            served,
            {
              tolerance: TECHNICAL_TOLERANCE(expected),
              justification:
                "Decimal(20,8) storage quantization + float64 accumulation",
            },
          );
        }
      }
    }

    // Intrinsic values and blends against the reference engine on the same trading days.
    const statements = await readStatements(prisma, security.id);
    const valuations = dailyValuations(statements, reference.dates);
    let intrinsicPoints = 0;
    const servedModels = new Map(
      body.intrinsicValues.map((point) => [
        `${point.model}|${point.valuationDate}`,
        point,
      ]),
    );
    const servedBlends = new Map(
      body.intrinsicValueBlends.map((point) => [
        `${point.blendId}|${point.valuationDate}`,
        point,
      ]),
    );
    const latestModel: Record<string, { value: number; date: string } | null> =
      {};
    const latestBlend: Record<string, { value: number; date: string } | null> =
      {};
    for (const bar of bars) {
      const position = index.get(bar.date);
      if (position === undefined) {
        continue;
      }
      const valuation = valuations[position]!;
      for (const model of MODEL_IDS) {
        const outcome = valuation.models[model];
        const expected = outcome.status === "VALUE" ? outcome.value : null;
        const served = servedModels.get(`${model}|${bar.date}`);
        intrinsicPoints += 1;
        if (expected === null || served === undefined) {
          ledger.check(
            "stock-details-intrinsic",
            `${symbol} ${bar.date} ${model} availability`,
            expected !== null,
            served !== undefined,
            "exact-number",
          );
        } else {
          ledger.check(
            "stock-details-intrinsic",
            `${symbol} ${bar.date} ${model}`,
            expected,
            served.valuePerShare,
            {
              tolerance: 0.5e-8 + 1e-12 * Math.abs(expected),
              justification: "Decimal(20,8) storage quantization",
            },
          );
          ledger.check(
            "stock-details-intrinsic",
            `${symbol} ${bar.date} ${model} sourceDataAsOf`,
            outcome.status === "VALUE" ? outcome.sourceAsOf : null,
            served.sourceDataAsOf.slice(0, 10),
            "exact-text",
          );
        }
        if (expected !== null) {
          latestModel[model] = { value: expected, date: bar.date };
        }
      }
      for (const blend of BLEND_IDS) {
        const expected = valuation.blends[blend]?.value ?? null;
        const served = servedBlends.get(`${blend}|${bar.date}`);
        intrinsicPoints += 1;
        if (expected === null || served === undefined) {
          ledger.check(
            "stock-details-intrinsic",
            `${symbol} ${bar.date} ${blend} availability`,
            expected !== null,
            served !== undefined,
            "exact-number",
          );
        } else {
          ledger.check(
            "stock-details-intrinsic",
            `${symbol} ${bar.date} ${blend}`,
            expected,
            served.valuePerShare,
            {
              tolerance: 0.5e-8 + 1e-12 * Math.abs(expected),
              justification: "Decimal(20,8) storage quantization",
            },
          );
        }
        if (expected !== null) {
          latestBlend[blend] = { value: expected, date: bar.date };
        }
      }
    }

    // What the page must show, derived from the persisted rows (never from the API response).
    const latest = bars[bars.length - 1];
    const previous = bars[bars.length - 2];
    // The moving averages the page renders come from the **stored** row for that session, not from
    // the reference recomputation. The two agree within this section's stated tolerance — that is
    // what the 42,670 comparisons above establish — but a display expectation has no tolerance: at
    // a rounding midpoint, 1.4e-14 becomes a whole cent. DIS held `sma20d` 106.48500000 on
    // 2026-09-22, which is $106.49; the reference's own 106.48499999999999 formats as $106.48, and
    // the mismatch would have been read as the page showing the wrong number. The question the UI
    // stage asks is whether the page shows the value FactorSage holds; whether that value is right
    // is asked, independently, above.
    const storedTechnicals =
      latest === undefined
        ? undefined
        : (
            await prisma.$queryRawUnsafe<Record<string, string | null>[]>(
              `select ${INDICATORS.filter(
                (indicator) => indicator.kind !== "RSI",
              )
                .map(
                  (indicator) =>
                    `"${indicator.column}"::text as "${indicator.column}"`,
                )
                .join(", ")}
                 from "DailyDerivedState" where "securityId" = $1 and date = $2::date`,
              security.id,
              latest.date,
            )
          )[0];
    uiExpectations.push({
      symbol,
      currency: security.currency,
      window: { from, to },
      latest: latest
        ? {
            date: latest.date,
            close: Number(latest.close),
            high: Number(latest.high),
            low: Number(latest.low),
            volume: Number(latest.volume),
          }
        : null,
      previousClose: previous ? Number(previous.close) : null,
      change:
        latest && previous
          ? Number(latest.close) - Number(previous.close)
          : null,
      changeFraction:
        latest && previous
          ? (Number(latest.close) - Number(previous.close)) /
            Number(previous.close)
          : null,
      windowLow: Math.min(...bars.map((bar) => Number(bar.low))),
      windowHigh: Math.max(...bars.map((bar) => Number(bar.high))),
      models: latestModel,
      blends: latestBlend,
      movingAverages: Object.fromEntries(
        INDICATORS.filter((indicator) => indicator.kind !== "RSI").map(
          (indicator) => {
            const stored = storedTechnicals?.[indicator.column] ?? null;
            return [indicator.column, stored === null ? null : Number(stored)];
          },
        ),
      ),
    });
    perSymbol[symbol] = {
      why,
      bars: bars.length,
      technicalValues,
      intrinsicPoints,
    };
    input.log(
      `  stock details ${symbol}: ${bars.length} bars, ${technicalValues} technical values, ${intrinsicPoints} intrinsic points`,
    );
  }
  writer.writeJson("stock-details/summary.json", {
    window: { from, to },
    symbols: STOCK_DETAIL_SYMBOLS,
    perSymbol,
    comparisons: ledger.totals(),
    byCategory: ledger.byCategory(),
    differences: ledger.differences,
  });
  writer.writeJson("ui/stock-details-expectations.json", {
    symbols: uiExpectations,
  });
  return {
    ledger,
    detail: {
      window: { from, to },
      perSymbol,
      byCategory: ledger.byCategory(),
    },
  };
}
