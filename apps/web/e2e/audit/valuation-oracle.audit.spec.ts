import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VALUATION_RATIO_CATALOG,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import { formatMultiple } from "../../src/features/stocks/details/utils/format";
import { expect, test, type Locator, type Page } from "../fixtures";

/**
 * Valuation ratios in the browser against the audit's clean-room oracle
 * (`docs/valuation-ratios-audit/REPORT.md`, Stock Details).
 *
 * For each security and ratio the audit chose, the page's own answer from
 * `/stocks/:symbol/valuation-ratios/daily` must equal the oracle's reading of the stored rows on
 * every session, and the hover legend must print, on every session the pointer reaches, exactly
 * what the product's formatter makes of the oracle's value — or `Unavailable` where the oracle
 * withholds it. The expectations are a file the audit command wrote
 * (`pnpm audit:valuation -- browser-expectations`), so this spec never computes a ratio.
 */

type Expectations = Record<
  string,
  Record<string, Record<string, number | null>>
>;

const file = process.env.VALUATION_AUDIT_EXPECTATIONS;
/**
 * The day the audit copy was frozen, when the stack reads it later: the API runs on that clock
 * (`pinned-clock.cjs`), and the page must too, or it asks for sessions the copy cannot hold.
 */
const pinnedNow = process.env.VALUATION_AUDIT_NOW;
const expectations: Expectations = file
  ? (JSON.parse(readFileSync(resolve(file), "utf8")) as Expectations)
  : {};
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
];

function priceChart(page: Page, symbol: string): Locator {
  return page.getByRole("img", {
    name: new RegExp(`${symbol} daily closing price chart`),
  });
}

function legendDate(text: string): string {
  const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(text.trim());
  if (!match) {
    throw new Error(`Unrecognised legend date '${text}'`);
  }
  const month = String(MONTHS.indexOf(match[1]!) + 1).padStart(2, "0");
  return `${match[3]}-${month}-${match[2]!.padStart(2, "0")}`;
}

async function sweepLegend(
  page: Page,
  symbol: string,
  label: string,
  steps: number,
): Promise<Map<string, string | null>> {
  const chart = priceChart(page, symbol);
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  expect(box).not.toBeNull();
  const legend = page.getByTestId("chart-legend");
  const seen = new Map<string, string | null>();
  const left = box!.x + 2;
  const right = box!.x + box!.width - 80;
  for (let step = 0; step <= steps; step += 1) {
    await page.mouse.move(
      left + ((right - left) * step) / steps,
      box!.y + box!.height * 0.25,
    );
    const rows = await legend.evaluate((element: HTMLElement) =>
      element.hidden
        ? null
        : [...element.children].map((child) => [
            child.children[child.children.length - 2]?.textContent ?? "",
            child.querySelector("strong")?.textContent ?? "",
          ]),
    );
    if (!rows || rows.length === 0) {
      continue;
    }
    const row = rows.find(([name]) => name === label);
    seen.set(legendDate(rows[0]![0]!), row ? row[1]! : null);
  }
  return seen;
}

test.describe("valuation ratios in the browser, against the audit oracle", () => {
  test.skip(
    !file,
    "set VALUATION_AUDIT_EXPECTATIONS to the audit's expectations file",
  );

  for (const [symbol, ratios] of Object.entries(expectations)) {
    for (const entry of VALUATION_RATIO_CATALOG) {
      const id = entry.id as ValuationRatioId;
      const expected = ratios[id];
      if (!expected) {
        continue;
      }
      test(`${symbol} ${entry.label}: the server's rows and the hover legend are the oracle's`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        if (pinnedNow) {
          await page.clock.setFixedTime(new Date(pinnedNow));
        }
        await page.goto(`/stocks/${symbol}`);
        await expect(priceChart(page, symbol)).toBeVisible();
        const wrapper = priceChart(page, symbol).locator("..").first();
        await expect(wrapper).toHaveAttribute("data-loading", "false");
        const answer = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              `/stocks/${symbol}/valuation-ratios/daily` &&
            new URL(response.url()).searchParams.get("ratio") === id,
        );
        await page.getByTestId("indicators-trigger").click();
        await page
          .getByTestId("indicators-panel")
          .getByRole("combobox", { name: "Valuation ratio" })
          .selectOption(id);
        await expect(wrapper).toHaveAttribute("data-valuation", id);
        const rows = (await (await answer).json()) as {
          date: string;
          value?: number;
        }[];
        await page.keyboard.press("Escape");

        // The server's rows: every session the expectations hold, valued as the oracle values it,
        // and no stored session left out between the first row and the last.
        expect(rows.length).toBeGreaterThan(200);
        const answered = new Set(rows.map((row) => row.date));
        const omitted = Object.keys(expected).filter(
          (date) =>
            date >= rows[0]!.date &&
            date <= rows.at(-1)!.date &&
            !answered.has(date),
        );
        expect(omitted, "stored sessions missing from the answer").toEqual([]);
        for (const row of rows) {
          expect(
            Object.hasOwn(expected, row.date),
            `${row.date} is a stored session`,
          ).toBe(true);
          const oracle = expected[row.date];
          if (oracle === null) {
            expect(row.value, `${row.date} is withheld`).toBeUndefined();
          } else {
            expect(row.value, `${row.date} is available`).toBeDefined();
            expect(
              Math.abs(row.value! - oracle!),
              `${row.date}: ${row.value} against ${oracle}`,
            ).toBeLessThanOrEqual(Math.abs(oracle!) * 1e-12);
          }
        }

        // The hover legend: exactly the product's formatting of the oracle's value, or Unavailable.
        const seen = await sweepLegend(page, symbol, entry.label, 900);
        let compared = 0;
        for (const [date, text] of seen) {
          if (!Object.hasOwn(expected, date)) {
            continue;
          }
          const oracle = expected[date];
          expect(text, `${date} legend`).toBe(
            oracle === null ? "Unavailable" : formatMultiple(oracle!),
          );
          compared += 1;
        }
        // The pointer reached nearly every loaded session.
        expect(compared).toBeGreaterThan(rows.length * 0.9);
      });
    }
  }
});
