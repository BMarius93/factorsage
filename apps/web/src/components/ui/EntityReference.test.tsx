import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EntityReferenceChip, LinkedEntities } from "./EntityReference";

describe("EntityReferenceChip", () => {
  it("links to the referenced entity", () => {
    render(
      <EntityReferenceChip
        kind="strategy"
        name="Deep value"
        href="/strategies/s-1"
      />,
    );

    const link = screen.getByRole("link", { name: "Deep value" });
    expect(link.getAttribute("href")).toBe("/strategies/s-1");
    expect(link.getAttribute("data-kind")).toBe("strategy");
  });

  it("renders as text when the entity has no page", () => {
    // A Benchmark is system-owned comparison data, and a Strategy deleted after the run
    // that snapshotted it no longer resolves. Neither may become a link that 404s.
    render(<EntityReferenceChip kind="benchmark" name="S&P 500" />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("S&P 500")).toBeDefined();
  });

  it("keeps the full name available when the label is truncated", () => {
    render(
      <EntityReferenceChip
        kind="list"
        name="A very long stock list name"
        href="/lists/l-1"
      />,
    );
    expect(
      screen.getByRole("link").getAttribute("title"),
    ).toBe("A very long stock list name");
  });

  it("is one treatment everywhere, with no quieter variant to drift from it", () => {
    render(
      <EntityReferenceChip
        kind="monitor"
        name="Nasdaq Trend Confirmation"
        href="/monitors/m-1"
      />,
    );
    const chip = screen.getByRole("link", {
      name: "Nasdaq Trend Confirmation",
    });
    expect(chip.hasAttribute("data-variant")).toBe(false);
    expect(chip.getAttribute("data-kind")).toBe("monitor");
    // The name is whole in the DOM and in the tooltip: wrapping and clipping are the CSS's job.
    expect(chip.getAttribute("title")).toBe("Nasdaq Trend Confirmation");
    expect(chip.textContent).toBe("Nasdaq Trend Confirmation");
  });
});

describe("LinkedEntities", () => {
  it("labels each relationship and links the ones that resolve", () => {
    render(
      <LinkedEntities
        entities={[
          {
            label: "Strategy",
            kind: "strategy",
            name: "Deep value",
            href: "/strategies/s-1",
          },
          {
            label: "Stock list",
            kind: "list",
            name: "Quality",
            href: "/lists/l-1",
          },
          { label: "Benchmark", kind: "benchmark", name: "S&P 500" },
        ]}
      />,
    );

    expect(screen.getByText("Linked")).toBeDefined();
    expect(screen.getByText("Strategy")).toBeDefined();
    expect(screen.getByText("Stock list")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Deep value" }).getAttribute("href"),
    ).toBe("/strategies/s-1");
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("renders nothing when there is no relationship to show", () => {
    const { container } = render(
      <LinkedEntities
        entities={[{ label: "Strategy", kind: "strategy", name: "  " }]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
