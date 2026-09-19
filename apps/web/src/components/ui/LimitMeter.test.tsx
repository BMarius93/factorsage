import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LimitMeter } from "./LimitMeter";

describe("LimitMeter", () => {
  it("states usage against the limit in words", () => {
    render(
      <LimitMeter
        label="Stocks"
        usage={7}
        limit={10}
        unit={["stock", "stocks"]}
        testId="m"
      />,
    );
    expect(screen.getByTestId("m").textContent).toContain("7 of 10 stocks");
    expect(screen.getByTestId("m").getAttribute("data-state")).toBe("open");
  });

  it("says when the limit is reached and when it is exceeded", () => {
    const { rerender } = render(
      <LimitMeter
        label="Monitors"
        usage={1}
        limit={1}
        unit={["monitor", "monitors"]}
        testId="m"
      />,
    );
    expect(screen.getByTestId("m").textContent).toContain(
      "at your plan's limit",
    );
    expect(screen.getByTestId("m").getAttribute("data-state")).toBe("full");
    rerender(
      <LimitMeter
        label="Monitors"
        usage={3}
        limit={1}
        unit={["monitor", "monitors"]}
        testId="m"
      />,
    );
    expect(screen.getByTestId("m").textContent).toContain(
      "2 over your plan's limit",
    );
    expect(screen.getByTestId("m").getAttribute("data-state")).toBe("over");
  });

  it("treats an unbounded limit as a count with no ceiling", () => {
    render(
      <LimitMeter
        label="Lists"
        usage={4}
        limit={null}
        unit={["list", "lists"]}
        testId="m"
      />,
    );
    expect(screen.getByTestId("m").textContent).toContain("4 lists");
    expect(screen.getByTestId("m").textContent).not.toContain(" of ");
  });
});
