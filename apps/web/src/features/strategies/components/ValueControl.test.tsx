import type { StrategyMetric, StrategyValue } from "@intrinsic/contracts";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ValueControl } from "./ValueControl";

const DEBT_TO_EQUITY: StrategyMetric = {
  kind: "FUNDAMENTAL",
  metricId: "DEBT_TO_EQUITY",
};

/** The Builder's ownership of the Value, reduced: the draft holds a number, the field its text. */
function Harness(props: {
  readonly initial: StrategyValue;
  readonly seen: number[];
  readonly expose?: (set: (value: StrategyValue) => void) => void;
}) {
  const [value, setValue] = useState<StrategyValue>(props.initial);
  props.expose?.(setValue);
  return (
    <ValueControl
      metric={DEBT_TO_EQUITY}
      value={value}
      label="Value"
      invalid={false}
      onBlur={() => {}}
      onChange={(next) => {
        if (next.kind !== "SERIES") props.seen.push(next.value);
        setValue(next);
      }}
    />
  );
}

/**
 * Chromium's reports while `0.75` and `-1.5` are typed key by key: a half-typed entry the number
 * input cannot parse (`0.`, `-`, `-1.`) is reported as an empty string. jsdom cannot keep the
 * visible text of such an entry, so the real keystrokes are the Playwright case
 * (`e2e/strategies/value-entry.user.spec.ts`); this proves what the control does with each report.
 */
function report(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

describe("the numeric Value field (UI-01)", () => {
  it("hands the draft the number each report means, and no number for a half-typed one", () => {
    const seen: number[] = [];
    render(
      <Harness
        initial={{ kind: "MULTIPLE", value: 1 } as StrategyValue}
        seen={seen}
      />,
    );
    const input = screen.getByTestId("value-control");

    for (const step of ["", "0", "", "0.7", "0.75"]) report(input, step);
    expect(seen.map((value) => (Number.isNaN(value) ? "NaN" : value))).toEqual([
      "NaN",
      0,
      "NaN",
      0.7,
      0.75,
    ]);
    expect((input as HTMLInputElement).value).toBe("0.75");

    for (const step of ["", "", "-1", "", "-1.5"]) report(input, step);
    expect(seen.at(-1)).toBe(-1.5);
    expect((input as HTMLInputElement).value).toBe("-1.5");
  });

  it("never writes the draft's placeholder number back over what is being typed", () => {
    const seen: number[] = [];
    render(
      <Harness
        initial={{ kind: "MULTIPLE", value: 2 } as StrategyValue}
        seen={seen}
      />,
    );
    const input = screen.getByTestId("value-control") as HTMLInputElement;

    report(input, "");
    // The draft now holds NaN; the field must not show "NaN" or the old 2.
    expect(input.value).toBe("");
    report(input, "0");
    expect(input.value).toBe("0");
    expect(seen.at(-1)).toBe(0);
  });

  it("keeps zero, a trailing zero and a negative zero exactly as typed", () => {
    const seen: number[] = [];
    render(
      <Harness
        initial={{ kind: "MULTIPLE", value: 3 } as StrategyValue}
        seen={seen}
      />,
    );
    const input = screen.getByTestId("value-control") as HTMLInputElement;

    report(input, "0");
    expect([input.value, seen.at(-1)]).toEqual(["0", 0]);
    report(input, "2.50");
    expect([input.value, seen.at(-1)]).toEqual(["2.50", 2.5]);
    report(input, "-0");
    expect(input.value).toBe("-0");
    expect(Object.is(seen.at(-1), -0)).toBe(true);
  });

  it("follows the draft when the number changes without the field: a reset or a loaded strategy", () => {
    const seen: number[] = [];
    let set: (value: StrategyValue) => void = () => {};
    render(
      <Harness
        initial={{ kind: "MULTIPLE", value: 0.5 } as StrategyValue}
        seen={seen}
        expose={(setter) => {
          set = setter;
        }}
      />,
    );
    const input = screen.getByTestId("value-control") as HTMLInputElement;
    expect(input.value).toBe("0.5");

    act(() => set({ kind: "MULTIPLE", value: 1.25 } as StrategyValue));
    expect(input.value).toBe("1.25");

    act(() => set({ kind: "MULTIPLE", value: Number.NaN } as StrategyValue));
    expect(input.value).toBe("");
  });
});
