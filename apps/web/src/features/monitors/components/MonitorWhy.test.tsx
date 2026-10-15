import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MonitorWhy } from "./MonitorWhy";

describe("MonitorWhy", () => {
  it("shows a trigger's crossing with the values on both sessions", () => {
    render(
      <MonitorWhy
        why={{
          basis: "EVIDENCE",
          sessionDate: "2026-10-13",
          rules: [
            {
              exitRule: 2,
              predicates: [
                {
                  role: "CONDITION",
                  description: "RSI 14D is below 30",
                  result: "TRUE",
                  metric: 27.4,
                  value: 30,
                },
                {
                  role: "TRIGGER",
                  description: "Price crosses above SMA 20D",
                  result: "TRUE",
                  metric: 105,
                  value: 100,
                  previousMetric: 95,
                  previousValue: 100,
                },
              ],
            },
          ],
        }}
      />,
    );
    const why = screen.getByTestId("monitor-why");
    expect(why.getAttribute("data-basis")).toBe("EVIDENCE");
    expect(why.textContent).toContain("Exit rule 2:");
    expect(why.textContent).toContain("RSI 14D is below 30 (27.40 vs 30.00)");
    expect(why.textContent).toContain(
      "Trigger: ✓ Price crosses above SMA 20D (95.00 → 105.00 vs 100.00)",
    );
    expect(why.textContent).toContain("held");
  });

  it("says a value did not resolve rather than showing a zero", () => {
    render(
      <MonitorWhy
        why={{
          basis: "EVIDENCE",
          rules: [
            {
              predicates: [
                {
                  role: "CONDITION",
                  description: "Margin of Safety is above 20%",
                  result: "NOT_EVALUABLE",
                  metric: null,
                  value: 20,
                },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("monitor-why").textContent).toContain(
      "(n/a vs 20.00)",
    );
    expect(screen.getByTestId("monitor-why").textContent).toContain(
      "could not be decided",
    );
  });

  it("renders a dash when nothing can explain the row", () => {
    const { container } = render(<MonitorWhy why={undefined} />);
    expect(container.textContent).toBe("—");
  });
});
