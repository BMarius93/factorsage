import type {
  DailyPrice,
  DateRange,
  FinancialStatementCadence,
  FinancialStatementDraft,
  FinancialStatementType,
  Security,
  SecurityProfile,
} from "@intrinsic/domain";
import {
  BALANCE_SHEET_FIELDS,
  CASH_FLOW_FIELDS,
  INCOME_STATEMENT_FIELDS,
} from "@intrinsic/domain";

export type FmpProfileDto = {
  symbol?: unknown;
  companyName?: unknown;
  exchange?: unknown;
  exchangeFullName?: unknown;
  currency?: unknown;
  cik?: unknown;
  isin?: unknown;
  cusip?: unknown;
  country?: unknown;
  sector?: unknown;
  industry?: unknown;
  ipoDate?: unknown;
  isEtf?: unknown;
  isFund?: unknown;
  isAdr?: unknown;
  isActivelyTrading?: unknown;
  description?: unknown;
  website?: unknown;
  image?: unknown;
  ceo?: unknown;
  fullTimeEmployees?: unknown;
  address?: unknown;
  city?: unknown;
  state?: unknown;
  zip?: unknown;
};

export type FmpDailyPriceDto = {
  date?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
  vwap?: unknown;
};

export type MappedFmpProfile = {
  providerSymbol: string;
  security: Omit<Security, "id">;
  profile: Omit<SecurityProfile, "securityId">;
};

type FmpFinancialStatementDto = {
  symbol?: unknown;
  date?: unknown;
  reportedCurrency?: unknown;
  cik?: unknown;
  filingDate?: unknown;
  acceptedDate?: unknown;
  fiscalYear?: unknown;
  period?: unknown;
} & Record<string, unknown>;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid FMP ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "null") {
    return undefined;
  }
  return normalized;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function finiteNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid FMP ${field}`);
  }
  return parsed;
}

function employees(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = finiteNumber(value, "fullTimeEmployees");
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Invalid FMP fullTimeEmployees");
  }
  return parsed;
}

function localDate(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) {
    throw new Error(`Invalid FMP ${field}`);
  }
  return parsed;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "string" && value.trim().toLowerCase() === "null") {
    return undefined;
  }
  return finiteNumber(value, field);
}

function fiscalYear(value: unknown): number {
  const parsed = finiteNumber(value, "fiscalYear");
  if (!Number.isInteger(parsed)) {
    throw new Error("Invalid FMP fiscalYear");
  }
  return parsed;
}

function financialPeriod(value: unknown): FinancialStatementDraft["period"] {
  const parsed = requiredString(value, "period").toUpperCase();
  if (parsed !== "FY" && parsed !== "Q1" && parsed !== "Q2" && parsed !== "Q3" && parsed !== "Q4") {
    throw new Error("Invalid FMP period");
  }
  return parsed;
}

function mapFinancialValues<T extends readonly string[]>(
  row: FmpFinancialStatementDto,
  fields: T,
): Record<string, number> {
  const mapped: Record<string, number> = {};
  for (const field of fields) {
    const value = optionalNumber(row[field], field);
    if (value !== undefined) {
      mapped[field] = value;
    }
  }
  return mapped;
}

function mapFmpFinancialStatementRows<T extends FinancialStatementType>(input: {
  securityId: string;
  statementType: T;
  rows: readonly FmpFinancialStatementDto[];
  fields: readonly string[];
}): FinancialStatementDraft<T>[] {
  return input.rows.map((row) => {
    requiredString(row.symbol, "financial statement symbol");
    const period = financialPeriod(row.period);
    return {
      securityId: input.securityId,
      statementType: input.statementType,
      fiscalDate: localDate(row.date, "financial statement date"),
      fiscalYear: fiscalYear(row.fiscalYear),
      period,
      reportedCurrency: requiredString(row.reportedCurrency, "reportedCurrency"),
      filingDate: localDate(row.filingDate, "filingDate"),
      ...(typeof row.acceptedDate === "string" && row.acceptedDate.trim()
        ? { providerAcceptedDate: row.acceptedDate.trim() }
        : {}),
      values: mapFinancialValues(row, input.fields) as FinancialStatementDraft<T>["values"],
    };
  });
}

export function normalizeFmpPercentage(
  value: number | string | null | undefined,
  sourceUnit: "DECIMAL" | "PERCENT_POINTS",
): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = finiteNumber(value, "percentage");
  return sourceUnit === "PERCENT_POINTS" ? parsed / 100 : parsed;
}

export function mapFmpProfile(dto: FmpProfileDto): MappedFmpProfile {
  const symbol = requiredString(dto.symbol, "profile symbol").toUpperCase();
  const exchangeCode = requiredString(dto.exchange, "profile exchange");
  const addressCountry = optionalString(dto.country);

  return {
    providerSymbol: symbol,
    security: {
      symbol,
      name: requiredString(dto.companyName, "profile companyName"),
      exchangeCode,
      exchangeName: optionalString(dto.exchangeFullName),
      currency: requiredString(dto.currency, "profile currency"),
      cik: optionalString(dto.cik),
      isin: optionalString(dto.isin),
      cusip: optionalString(dto.cusip),
      country: addressCountry,
      sector: optionalString(dto.sector),
      industry: optionalString(dto.industry),
      ipoDate: optionalString(dto.ipoDate),
      type: boolean(dto.isEtf, false)
        ? "ETF"
        : boolean(dto.isFund, false)
          ? "FUND"
          : "STOCK",
      isAdr: boolean(dto.isAdr, false),
      isActivelyTrading: boolean(dto.isActivelyTrading, true),
    },
    profile: {
      description: optionalString(dto.description),
      website: optionalString(dto.website),
      logoUrl: optionalString(dto.image),
      ceo: optionalString(dto.ceo),
      employees: employees(dto.fullTimeEmployees),
      address: {
        street: optionalString(dto.address),
        city: optionalString(dto.city),
        state: optionalString(dto.state),
        postalCode: optionalString(dto.zip),
        country: addressCountry,
      },
    },
  };
}

export function mapFmpDailyPrices(
  securityId: string,
  rows: readonly FmpDailyPriceDto[],
): DailyPrice[] {
  return rows
    .map((row) => ({
      securityId,
      date: localDate(row.date, "historical date"),
      open: finiteNumber(row.open, "historical open"),
      high: finiteNumber(row.high, "historical high"),
      low: finiteNumber(row.low, "historical low"),
      close: finiteNumber(row.close, "historical close"),
      volume: finiteNumber(row.volume, "historical volume"),
      ...(row.vwap === null || row.vwap === undefined
        ? {}
        : { vwap: finiteNumber(row.vwap, "historical vwap") }),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function financialStatementPath(statementType: FinancialStatementType): string {
  switch (statementType) {
    case "INCOME":
      return "stable/income-statement";
    case "BALANCE_SHEET":
      return "stable/balance-sheet-statement";
    case "CASH_FLOW":
      return "stable/cash-flow-statement";
  }
}

function statementFields(statementType: FinancialStatementType): readonly string[] {
  switch (statementType) {
    case "INCOME":
      return INCOME_STATEMENT_FIELDS;
    case "BALANCE_SHEET":
      return BALANCE_SHEET_FIELDS;
    case "CASH_FLOW":
      return CASH_FLOW_FIELDS;
  }
}

export function mapFmpFinancialStatements<T extends FinancialStatementType>(input: {
  securityId: string;
  statementType: T;
  rows: readonly FmpFinancialStatementDto[];
}): FinancialStatementDraft<T>[] {
  return mapFmpFinancialStatementRows({
    securityId: input.securityId,
    statementType: input.statementType,
    rows: input.rows,
    fields: statementFields(input.statementType),
  });
}

export type FmpStockProviderPort = {
  getProfile(symbol: string): Promise<MappedFmpProfile | null>;
  getDailyPrices(
    symbol: string,
    securityId: string,
    range: DateRange,
  ): Promise<DailyPrice[]>;
  getFinancialStatements(
    symbol: string,
    securityId: string,
    statementType: FinancialStatementType,
    cadence: FinancialStatementCadence,
    limit: number,
  ): Promise<FinancialStatementDraft[]>;
};
