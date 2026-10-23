import type {
  MonitorWhyPredicateResponse,
  MonitorWhyResponse,
} from "@intrinsic/contracts";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ActivityConditions } from "./ActivityConditions";

function predicate(
  description: string,
  overrides: Partial<MonitorWhyPredicateResponse> = {},
): MonitorWhyPredicateResponse {
  return {
    role: "CONDITION",
    description,
    result: "TRUE",
    metric: 2,
    value: 1,
    ...overrides,
  };
}

function lines() {
  return screen.getAllByTestId("dashboard-condition").map((line) => ({
    mark: line.children[0]?.textContent ?? "",
    expression: within(line).getByTestId("dashboard-condition-expression")
      .textContent,
    values:
      within(line).queryByTestId("dashboard-condition-values")?.textContent ??
      null,
    result: line.getAttribute("data-result"),
  }));
}

describe("ActivityConditions", () => {
  it("lists every predicate on its own line, in the Strategy's order, with its result and its values", () => {
    const why: MonitorWhyResponse = {
      basis: "EVIDENCE",
      sessionDate: "2026-10-20",
      rules: [
        {
          predicates: [
            predicate("RSI 14D is below 55", { metric: 42.5, value: 55 }),
            predicate("Price is above EMA 20D", {
              metric: 419.26,
              value: 412.3,
            }),
            predicate("MACD is above MACD signal", {
              metric: 2.31,
              value: 1.85,
            }),
            predicate("Relative volume is above 1.2", {
              result: "FALSE",
              metric: 0.85,
              value: 1.2,
            }),
          ],
        },
      ],
    };
    render(<ActivityConditions why={why} />);

    expect(lines()).toEqual([
      {
        mark: "✓",
        expression: "RSI 14D is below 55",
        values: "42.50 < 55.00",
        result: "TRUE",
      },
      {
        mark: "✓",
        expression: "Price is above EMA 20D",
        values: "419.26 > 412.30",
        result: "TRUE",
      },
      {
        mark: "✓",
        expression: "MACD is above MACD signal",
        values: "2.31 > 1.85",
        result: "TRUE",
      },
      {
        mark: "✕",
        expression: "Relative volume is above 1.2",
        values: "0.85 < 1.20",
        result: "FALSE",
      },
    ]);
    // The result is words for assistive technology, never only a glyph or a colour.
    const conditions = screen.getByTestId("dashboard-conditions");
    expect(conditions.textContent).toContain("RSI 14D is below 55 — held");
    expect(conditions.textContent).toContain(
      "Relative volume is above 1.2 — did not hold",
    );
    expect(
      screen.getAllByTestId("dashboard-condition")[0]!.children[0],
    ).toHaveProperty("ariaHidden", "true");
    // All of them are required, and a list of requirements says so itself: no `and` between them.
    for (const line of screen.getAllByTestId("dashboard-condition")) {
      expect(line.textContent).not.toMatch(/^and/i);
    }
    expect(
      screen
        .getByTestId("dashboard-conditions")
        .querySelector("ol")
        ?.getAttribute("data-structure"),
    ).toBe("all");
    expect(screen.queryByTestId("dashboard-condition-rule")).toBeNull();
  });

  it("marks the Trigger and writes its move, listed with the Conditions it is ANDed with", () => {
    render(
      <ActivityConditions
        why={{
          basis: "EVIDENCE",
          rules: [
            {
              predicates: [
                predicate("SMA 50D is above SMA 200D", {
                  metric: 98.4,
                  value: 92.1,
                }),
                predicate("Price crosses above SMA 20D", {
                  role: "TRIGGER",
                  previousMetric: 99.5,
                  previousValue: 100.4,
                  metric: 102.5,
                  value: 101,
                }),
              ],
            },
          ],
        }}
      />,
    );
    const [, trigger] = screen.getAllByTestId("dashboard-condition");
    expect(trigger!.getAttribute("data-role")).toBe("TRIGGER");
    expect(trigger!.textContent).toMatch(
      /^✓Trigger Price crosses above SMA 20D/,
    );
    expect(
      within(trigger!).getByTestId("dashboard-condition-values").textContent,
    ).toBe("99.50 → 102.50 > 101.00");
  });

  it("keeps Exit Rules apart: each under its label, the rules joined by or, never flattened into one list", () => {
    render(
      <ActivityConditions
        why={{
          basis: "EVIDENCE",
          rules: [
            {
              exitRule: 1,
              predicates: [
                predicate("RSI 14D is above 70", { metric: 72.1, value: 70 }),
                predicate("Price is below SMA 50D", {
                  result: "FALSE",
                  metric: 105,
                  value: 101,
                }),
              ],
            },
            {
              exitRule: 2,
              predicates: [
                predicate("Price is below SMA 200D", {
                  metric: 88,
                  value: 92,
                }),
              ],
            },
          ],
        }}
      />,
    );
    const items = within(screen.getByTestId("dashboard-conditions"))
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toEqual([
      "Exit rule 1",
      "✓RSI 14D is above 70 — held 72.10 > 70.00",
      "✕Price is below SMA 50D — did not hold 105.00 > 101.00",
      "orExit rule 2",
      "✓Price is below SMA 200D — held 88.00 < 92.00",
    ]);
    // The alternatives are marked as such, so each rule's lines indent under its label.
    expect(
      screen
        .getByTestId("dashboard-conditions")
        .querySelector("ol")
        ?.getAttribute("data-structure"),
    ).toBe("any-of-rules");
  });

  it("joins unlabelled alternative rules by or rather than reading them as one AND list", () => {
    render(
      <ActivityConditions
        why={{
          basis: "EVIDENCE",
          rules: [
            { predicates: [predicate("RSI 14D is above 70")] },
            { predicates: [predicate("Price is below SMA 200D")] },
          ],
        }}
      />,
    );
    const items = within(screen.getByTestId("dashboard-conditions"))
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toEqual([
      "✓RSI 14D is above 70 — held 2.00 > 1.00",
      "or",
      "✓Price is below SMA 200D — held 2.00 > 1.00",
    ]);
  });

  it("never draws an undecided predicate as a failure", () => {
    render(
      <ActivityConditions
        why={{
          basis: "EVIDENCE",
          rules: [
            {
              predicates: [
                predicate("P/E is below 20", {
                  result: "NOT_EVALUABLE",
                  metric: null,
                  value: 20,
                }),
              ],
            },
          ],
        }}
      />,
    );
    const [line] = lines();
    expect(line).toMatchObject({
      mark: "–",
      result: "NOT_EVALUABLE",
      values: "n/a vs 20.00",
    });
    expect(screen.getByTestId("dashboard-conditions").textContent).toContain(
      "could not be decided",
    );
    expect(
      screen.getByTestId("dashboard-conditions").textContent,
    ).not.toContain("did not hold");
  });

  it("never shows a Why without recorded values as if it had decided anything", () => {
    // The API admits no such event into the feed (§12); were one to arrive, it reads as unavailable
    // rather than as conditions with no values or an old "not recorded" note.
    render(
      <ActivityConditions
        why={{
          basis: "RULE_ONLY",
          rules: [
            {
              predicates: [
                { role: "CONDITION", description: "Price is above SMA 200D" },
                { role: "CONDITION", description: "RSI 14D is below 70" },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.queryAllByTestId("dashboard-condition")).toHaveLength(0);
    expect(
      screen.getByTestId("dashboard-conditions-unavailable").textContent,
    ).toBe("Conditions are not available for this event.");
    expect(screen.queryByText(/Values were not recorded/)).toBeNull();
  });

  it("shows all ten of ten conditions, with nothing folded away", () => {
    const predicates = Array.from({ length: 10 }, (_, index) =>
      predicate(`Condition number ${index + 1} is above ${index}`, {
        metric: index + 1,
        value: index,
      }),
    );
    render(
      <ActivityConditions
        why={{ basis: "EVIDENCE", rules: [{ predicates }] }}
      />,
    );
    expect(lines().map((line) => line.expression)).toEqual(
      predicates.map((one) => one.description),
    );
    const conditions = screen.getByTestId("dashboard-conditions");
    expect(conditions.querySelector("details, button, [hidden]")).toBeNull();
  });

  it("says when an event carries no conditions at all, rather than drawing an empty cell", () => {
    render(<ActivityConditions why={undefined} />);
    expect(
      screen.getByTestId("dashboard-conditions-unavailable").textContent,
    ).toBe("Conditions are not available for this event.");
  });

  it("makes the expression the line's primary text and the evaluation quieter", () => {
    // jsdom applies no stylesheet, so the hierarchy is held where it is declared.
    const css = readFileSync(
      resolve(
        process.cwd(),
        "src/features/dashboard/components/ActivityConditions.module.css",
      ),
      "utf8",
    );
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf("}", start));
    };
    expect(rule(".expression")).toMatch(/color: var\(--color-text-primary\)/);
    expect(rule(".expression")).toMatch(/font-weight: 500/);
    const values = rule(".values");
    expect(values).toMatch(/color: var\(--color-text-muted\)/);
    expect(values).toMatch(/font-size: var\(--text-small\)/);
    expect(values).toMatch(/font-weight: 400/);
    // The Trigger tag qualifies its line and never outweighs it.
    expect(rule(".role")).toMatch(/color: var\(--color-text-muted\)/);
    expect(rule(".role")).not.toMatch(/--weight-emphasis/);
  });

  it("never caps a row's height in its stylesheet", () => {
    // jsdom applies no stylesheet, so the promise is held where it lives: in the declarations.
    // Resolved from the package root, as Vitest runs with `apps/web` as its working directory.
    const sheet = (name: string) =>
      readFileSync(
        resolve(process.cwd(), "src/features/dashboard/components", name),
        "utf8",
      );
    const css = sheet("ActivityConditions.module.css");
    const feed = sheet("ActivityFeed.module.css");
    for (const sheet of [css, feed]) {
      expect(sheet).not.toMatch(/max-height|line-clamp/);
    }
    // The rules that lay out a row and its lines set no height and hide no overflow.
    const rule = (sheet: string, selector: string) => {
      const start = sheet.indexOf(`${selector} {`);
      expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
      return sheet.slice(start, sheet.indexOf("}", start));
    };
    for (const [sheet, selector] of [
      [feed, ".row"],
      [feed, ".row > td"],
      [css, ".conditions"],
      [css, ".lines"],
      [css, ".expression"],
    ] as const) {
      expect(rule(sheet, selector), selector).not.toMatch(
        /(^|[^-])height\s*:|overflow(-[xy])?\s*:/,
      );
    }
  });
});
