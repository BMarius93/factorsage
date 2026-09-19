import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { byName, type CollectionSort } from "./Collection";
import type { DataTableColumn } from "./DataTable";
import { CollectionSection } from "./OwnedCollection";

type Row = {
  readonly id: string;
  readonly name: string;
  readonly size: number;
};

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index + 1}`,
    // Zero-padded so the API order and the alphabetical order differ only where a test makes them.
    name: `Universe ${String(index + 1).padStart(2, "0")}`,
    size: index + 1,
  }));
}

const COLUMNS: readonly DataTableColumn<Row>[] = [
  {
    key: "name",
    header: "Name",
    cardRole: "identity",
    render: (row) => row.name,
  },
];

const SORTS: readonly CollectionSort<Row>[] = [
  { id: "newest", label: "Newest" },
  { id: "name", label: "Name A–Z", compare: byName },
  { id: "size", label: "Largest", compare: (a, b) => b.size - a.size },
];

function renderSection(data: readonly Row[], sorts = SORTS) {
  return render(
    <CollectionSection
      title="Your lists"
      label="Your lists"
      noun="lists"
      testId="your-lists"
      footerTestId="lists-footer"
      columns={COLUMNS}
      rows={data}
      getRowKey={(row) => row.id}
      searchText={(row) => row.name}
      sorts={sorts}
      emptyState={<p data-testid="lists-empty">Nothing yet</p>}
    />,
  );
}

function visibleNames(): string[] {
  return within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent ?? "");
}

describe("collection search, sort and paging (UI-010, UI-011)", () => {
  it.each([
    [0, false, false],
    [1, false, false],
    [9, false, true],
    [10, true, true],
    [25, true, true],
    [30, true, true],
    [60, true, true],
  ])("with %i records shows search: %s, sort: %s", (count, search, sort) => {
    renderSection(rows(count));
    expect(screen.queryByTestId("your-lists-search") !== null).toBe(search);
    expect(screen.queryByTestId("your-lists-sort") !== null).toBe(sort);
    if (count === 0) {
      expect(screen.getByTestId("lists-empty")).toBeDefined();
    } else {
      expect(visibleNames()).toHaveLength(Math.min(count, 25));
    }
  });

  it("shows no controls at all where order carries no meaning and records are few", () => {
    renderSection(rows(2), []);
    expect(screen.queryByTestId("your-lists-toolbar")).toBeNull();
  });

  it("filters by name, announces the count, and returns to the first page", async () => {
    const user = userEvent.setup();
    renderSection(rows(60));

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 2 of 3")).toBeDefined();

    await user.type(
      screen.getByRole("searchbox", { name: "Search lists" }),
      "5",
    );
    // 05, 15, 25, 35, 45, 50–59: 15 matches, all on page one.
    expect(visibleNames()).toHaveLength(15);
    expect(screen.queryByText(/Page \d of/)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "15 of 60 lists match “5”.",
    );
    expect(screen.getByText("Showing 1–15 of 15 lists")).toBeDefined();
  });

  it("offers the way back when a search matches nothing", async () => {
    const user = userEvent.setup();
    renderSection(rows(12));

    await user.type(
      screen.getByRole("searchbox", { name: "Search lists" }),
      "nothing like this",
    );
    const empty = screen.getByTestId("your-lists-filtered-empty");
    expect(empty.textContent).toContain("No lists match “nothing like this”");
    expect(screen.queryByRole("table")).toBeNull();

    await user.click(
      within(empty).getByRole("button", { name: "Clear search" }),
    );
    expect(visibleNames()).toHaveLength(12);
  });

  it("sorts with the Sort control, which is the only order control on a phone", async () => {
    const user = userEvent.setup();
    renderSection(rows(3));

    expect(visibleNames()).toEqual([
      "Universe 01",
      "Universe 02",
      "Universe 03",
    ]);
    await user.selectOptions(screen.getByLabelText("Sort"), "size");
    expect(visibleNames()).toEqual([
      "Universe 03",
      "Universe 02",
      "Universe 01",
    ]);
  });
});
