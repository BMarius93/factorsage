import {
  SELECTABLE_SERIES_CATALOG,
  type SelectableSeriesId,
} from "@intrinsic/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { overlayColorAt } from "../utils/chart-theme";
import { IndicatorsMenu } from "./IndicatorsMenu";

const ALL_IDS = new Set(
  SELECTABLE_SERIES_CATALOG.map((series) => series.id),
) as ReadonlySet<SelectableSeriesId>;

function Harness({
  available = ALL_IDS,
  initial = ["BALANCED"] as SelectableSeriesId[],
}: {
  available?: ReadonlySet<SelectableSeriesId>;
  initial?: SelectableSeriesId[];
}) {
  const [selected, setSelected] = useState(new Set(initial));
  return (
    <IndicatorsMenu
      selected={selected}
      available={available}
      onToggle={(id) =>
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        })
      }
      colorOf={(id) => (selected.has(id) ? overlayColorAt(0) : undefined)}
    />
  );
}

/** Resolved by test id so the panel can be inspected while it is still hidden. */
function panel() {
  return screen.getByTestId("indicators-panel");
}

describe("IndicatorsMenu", () => {
  it("is closed until the trigger is activated and reports the selection count", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: /Indicators/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel().hasAttribute("hidden")).toBe(true);
    expect(within(trigger).getByText("1")).toBeDefined();

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel().hasAttribute("hidden")).toBe(false);
  });

  it("opens and toggles entirely from the keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[]} />);

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Indicators/ }),
    );
    await user.keyboard("{Enter}");
    expect(panel().hasAttribute("hidden")).toBe(false);

    // Tab reaches the first option and Space toggles it, with no custom key handling needed.
    await user.tab();
    const first = document.activeElement as HTMLInputElement;
    expect(first.type).toBe("checkbox");
    await user.keyboard(" ");
    expect(first.checked).toBe(true);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: /Indicators/ });
    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(panel().hasAttribute("hidden")).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when a pointer press lands outside the control", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Harness />
        <button type="button">Elsewhere</button>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));

    expect(panel().hasAttribute("hidden")).toBe(true);
  });

  it("keeps every catalog entry discoverable and disables only the unavailable ones", async () => {
    const user = userEvent.setup();
    const available = new Set<SelectableSeriesId>(["SMA_20D", "BALANCED"]);
    render(<Harness available={available} initial={["BALANCED"]} />);

    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    const options = within(panel()).getAllByRole("checkbox");

    expect(options).toHaveLength(21);
    expect(
      options.filter((box) => (box as HTMLInputElement).disabled),
    ).toHaveLength(19);
    expect(within(panel()).getAllByText("Unavailable")).toHaveLength(19);
    // An unavailable entry is present and identified, never removed or swapped for another.
    expect(
      within(panel()).getByRole("checkbox", { name: "SMA 200W Unavailable" }),
    ).toBeDefined();
  });

  it("supports several simultaneous selections", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[]} />);

    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    for (const name of ["SMA 50D", "EMA 200W", "Conservative", "Graham"]) {
      await user.click(within(panel()).getByRole("checkbox", { name }));
    }

    const checked = within(panel())
      .getAllByRole("checkbox")
      .filter((box) => (box as HTMLInputElement).checked);
    expect(checked).toHaveLength(4);
    expect(
      within(screen.getByRole("button", { name: /Indicators/ })).getByText("4"),
    ).toBeDefined();
  });
});
