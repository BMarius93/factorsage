import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EntitySelect, type EntitySelectItem } from "./EntitySelect";
import { Select } from "./Select";

describe("Select", () => {
  it("keeps a value that is not among the options visible as unavailable (UI-045)", () => {
    render(
      <Select
        aria-label="Series"
        value="gone"
        onValueChange={() => {}}
        placeholder="Choose…"
        options={[{ value: "a", label: "A" }]}
      />,
    );
    const select = screen.getByLabelText("Series") as HTMLSelectElement;
    expect(select.value).toBe("gone");
    expect(select.selectedOptions[0]?.textContent).toBe("Unavailable");
  });

  it("shows the placeholder for an empty value and reports the chosen one", async () => {
    const onValueChange = vi.fn();
    render(
      <Select
        aria-label="Series"
        value=""
        onValueChange={onValueChange}
        placeholder="Choose…"
        groups={[{ label: "Group", options: [{ value: "a", label: "A" }] }]}
      />,
    );
    const select = screen.getByLabelText("Series") as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe("Choose…");
    expect(select.querySelector("[data-unavailable]")).toBeNull();
    await userEvent.selectOptions(select, "a");
    expect(onValueChange).toHaveBeenCalledWith("a");
  });

  it("carries its density and invalid state for the shared styles", () => {
    render(
      <Select
        aria-label="Metric"
        value="a"
        onValueChange={() => {}}
        density="compact"
        invalid
        options={[{ value: "a", label: "A" }]}
      />,
    );
    const select = screen.getByLabelText("Metric");
    expect(select.getAttribute("data-density")).toBe("compact");
    expect(select.getAttribute("aria-invalid")).toBe("true");
  });
});

const OWN: EntitySelectItem = { id: "own", name: "Mine", ownership: "USER" };
const BUILT_IN: EntitySelectItem = {
  id: "sys",
  name: "Quality",
  ownership: "SYSTEM",
};

function groupsOf(select: HTMLElement): string[] {
  return Array.from(select.querySelectorAll("optgroup")).map(
    (group) => group.label,
  );
}

describe("EntitySelect", () => {
  it("groups the caller's own content first, then the built-ins, like the collection pages", () => {
    render(
      <>
        <label htmlFor="s">Strategy</label>
        <EntitySelect
          id="s"
          kind="strategy"
          items={[BUILT_IN, OWN]}
          value=""
          onValueChange={() => {}}
        />
      </>,
    );
    expect(groupsOf(screen.getByLabelText("Strategy"))).toEqual([
      "Your strategies",
      "Built-in strategies",
    ]);
  });

  it("renders one kind of content without a lone group heading", () => {
    render(
      <>
        <label htmlFor="l">Stock list</label>
        <EntitySelect
          id="l"
          kind="list"
          items={[OWN]}
          value=""
          onValueChange={() => {}}
        />
      </>,
    );
    expect(groupsOf(screen.getByLabelText("Stock list"))).toEqual([]);
  });

  it("says it is loading and cannot be used until the options arrive", () => {
    render(
      <>
        <label htmlFor="l">Stock list</label>
        <EntitySelect
          id="l"
          kind="list"
          items={[]}
          value="own"
          loading
          onValueChange={() => {}}
        />
      </>,
    );
    const select = screen.getByLabelText("Stock list") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.selectedOptions[0]?.textContent).toBe("Loading stock lists…");
  });

  it("names a stale reference for what it was", () => {
    render(
      <>
        <label htmlFor="l">Stock list</label>
        <EntitySelect
          id="l"
          kind="list"
          items={[OWN]}
          value="deleted"
          onValueChange={() => {}}
        />
      </>,
    );
    const select = screen.getByLabelText("Stock list") as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe(
      "Unavailable stock list (deleted or not yours)",
    );
  });
});
