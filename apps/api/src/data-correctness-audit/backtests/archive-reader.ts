import { open as openZip, type Entry, type ZipFile } from "yauzl";

/**
 * Reads a forensic backtest archive (`docs/development/backtest-debug-archive.md`, schema 2) into
 * plain data. Pure I/O and JSON parsing: nothing here interprets a number.
 */

export type ArchiveFrameFile = {
  securityId: string;
  symbol: string;
  year: string;
  contextRowCount: number;
  dates: string[];
  closes: (number | null)[];
  operands: Record<string, (number | null)[]>;
  window: { requestedFrom: string; requestedTo: string };
};

export type BacktestArchive = {
  path: string;
  manifest: {
    archiveSchemaVersion: number;
    run: { runId: string; attempt: number; status: string };
  };
  snapshot: Record<string, unknown> & {
    period: { startDate: string; endDate: string };
    capital: { initialCapital: number; monthlyContribution: number };
    allocation: { maximumPositions: number; fullPositionFraction: number };
    strategy: { definition: unknown; name: string };
    stockList: { name: string };
    securities: {
      securityId: string;
      symbol: string;
      buyWindowMode: "FULL" | "CUSTOM";
      buyWindows: { startDate: string; endDate: string | null }[];
    }[];
    executionCalendar: { seriesId: string };
    benchmark: { seriesId: string; code: string };
  };
  calendar: string[];
  benchmark: { dates: string[]; closes: number[] } | null;
  preparation: {
    securities: {
      securityId: string;
      symbol: string;
      skipped: boolean;
      skipReason: string | null;
      coverage: {
        firstDate: string;
        lastDate: string;
        tradingDays: number;
      } | null;
    }[];
  };
  frames: ArchiveFrameFile[];
  contributions: { date: string; type: string; amount: number }[];
  result: {
    trades: Record<string, unknown>[];
    equity: Record<string, unknown>[];
    summary: Record<string, unknown> | null;
  };
};

function readAll(path: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    openZip(
      path,
      { lazyEntries: true },
      (error: Error | null, zip?: ZipFile) => {
        if (error || !zip) {
          reject(error ?? new Error(`cannot open ${path}`));
          return;
        }
        const files = new Map<string, Buffer>();
        zip.on("entry", (entry: Entry) => {
          if (entry.fileName.endsWith("/")) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              reject(streamError ?? new Error(`cannot read ${entry.fileName}`));
              return;
            }
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => {
              files.set(entry.fileName, Buffer.concat(chunks));
              zip.readEntry();
            });
            stream.on("error", reject);
          });
        });
        zip.on("end", () => resolve(files));
        zip.on("error", reject);
        zip.readEntry();
      },
    );
  });
}

function json<T>(files: Map<string, Buffer>, name: string): T {
  const file = files.get(name);
  if (!file) {
    throw new Error(`archive is missing ${name}`);
  }
  return JSON.parse(file.toString("utf8")) as T;
}

function ndjson<T>(files: Map<string, Buffer>, name: string): T[] {
  const file = files.get(name);
  if (!file) {
    return [];
  }
  return file
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

export async function readBacktestArchive(
  path: string,
): Promise<BacktestArchive> {
  const files = await readAll(path);
  const manifest = json<BacktestArchive["manifest"]>(files, "manifest.json");
  if (manifest.archiveSchemaVersion !== 2) {
    throw new Error(
      `${path}: archive schema ${manifest.archiveSchemaVersion} is not supported (expected 2)`,
    );
  }
  const calendarFile = json<{ dates: string[] }>(
    files,
    "inputs/execution-calendar.json",
  );
  const benchmarkFile = json<{
    prices: { date: string; close: number }[] | null;
  }>(files, "inputs/benchmark.json");
  const frames: ArchiveFrameFile[] = [];
  for (const [name, buffer] of files) {
    if (!name.startsWith("frames/") || !name.endsWith(".json")) {
      continue;
    }
    const raw = JSON.parse(buffer.toString("utf8")) as {
      securityId: string;
      symbol: string;
      window: { year: string; requestedFrom: string; requestedTo: string };
      contextRowCount: number;
      dates: string[];
      closes: (number | null)[];
      operands: Record<string, (number | null)[]>;
    };
    frames.push({
      securityId: raw.securityId,
      symbol: raw.symbol,
      year: raw.window.year,
      contextRowCount: raw.contextRowCount,
      dates: raw.dates,
      closes: raw.closes,
      operands: raw.operands ?? {},
      window: {
        requestedFrom: raw.window.requestedFrom,
        requestedTo: raw.window.requestedTo,
      },
    });
  }
  return {
    path,
    manifest,
    snapshot: json<BacktestArchive["snapshot"]>(files, "snapshot.json"),
    calendar: calendarFile.dates,
    benchmark:
      benchmarkFile.prices === null
        ? null
        : {
            dates: benchmarkFile.prices.map((entry) => entry.date),
            closes: benchmarkFile.prices.map((entry) => entry.close),
          },
    preparation: json<BacktestArchive["preparation"]>(
      files,
      "preparation/summary.json",
    ),
    frames,
    contributions: ndjson(files, "inputs/contributions.ndjson"),
    result: {
      trades: ndjson(files, "result/trades.ndjson"),
      equity: ndjson(files, "result/equity.ndjson"),
      summary: files.has("result/summary.json")
        ? json(files, "result/summary.json")
        : null,
    },
  };
}
