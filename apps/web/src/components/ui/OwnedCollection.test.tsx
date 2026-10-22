import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { byName, byNewest, type CollectionSort } from "./Collection";
import type { DataTableColumn } from "./DataTable";
import { CollectionSection, partitionByOwnership } from "./OwnedCollection";

type Row = { readonly id: string; readonly name: string; readonly ownership: "USER" | "SYSTEM" };

const COLUMNS: readonly DataTableColumn<Row>[] = [
  { key: "name", header: "Name", cardRole: "identity", render: (row) => row.name },
];

function rows(count: number, ownership: Row["ownership"] = "USER"): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${ownership}-${index}`,
    name: `${ownership} ${index}`,
    ownership,
  }));
}

describe("partitionByOwnership", () => {
  it("splits platform content from the viewer's own, keeping the API's order inside each", () => {
    const { own, builtIn } = partitionByOwnership([
      { id: "s1", name: "Built-in A", ownership: "SYSTEM" },
      { id: "u1", name: "Mine A", ownership: "USER" },
      { id: "s2", name: "Built-in B", ownership: "SYSTEM" },
      { id: "u2", name: "Mine B", ownership: "USER" },
    ]);

    expect(own.map((row) => row.id)).toEqual(["u1", "u2"]);
    expect(builtIn.map((row) => row.id)).toEqual(["s1", "s2"]);
  });
});

describe("CollectionSection", () => {
  it("renders its own empty state in place of the table, and nothing else", () => {
    render(
      <CollectionSection
        title="Your things"
        label="Your things"
        noun="things"
        testId="your-things"
        columns={COLUMNS}
        rows={[]}
        getRowKey={(row) => row.id}
        emptyState={<p data-testid="nothing-yet">Nothing yet</p>}
      />,
    );

    expect(screen.getByTestId("nothing-yet")).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
    // An empty section is still a section: its heading keeps the page's structure legible.
    expect(screen.getByRole("heading", { name: "Your things" })).toBeDefined();
  });

  /**
   * The reason this is a component and not a helper: two sections of one collection each own
   * their paging, so moving through the built-ins never moves the viewer's own list.
   */
  it("pages each section independently", async () => {
    const user = userEvent.setup();
    render(
      <>
        <CollectionSection
          title="Your things"
          label="Your things"
          noun="things"
          testId="your-things"
          tableTestId="your-things-table"
          footerTestId="your-things-footer"
          columns={COLUMNS}
          rows={rows(30)}
          getRowKey={(row) => row.id}
        />
        <CollectionSection
          title="Built-in things"
          label="Built-in things"
          noun="things"
          testId="built-in-things"
          tableTestId="built-in-things-table"
          footerTestId="built-in-things-footer"
          columns={COLUMNS}
          rows={rows(30, "SYSTEM")}
          getRowKey={(row) => row.id}
        />
      </>,
    );

    const ownFooter = screen.getByTestId("your-things-footer");
    const builtInFooter = screen.getByTestId("built-in-things-footer");
    expect(ownFooter.textContent).toContain("Showing 1–25 of 30 things");
    expect(builtInFooter.textContent).toContain("Showing 1–25 of 30 things");

    await user.click(within(builtInFooter).getByRole("button", { name: "Next" }));

    expect(builtInFooter.textContent).toContain("Showing 26–30 of 30 things");
    expect(ownFooter.textContent).toContain("Showing 1–25 of 30 things");
    expect(screen.getByTestId("your-things-table").textContent).toContain("USER 0");
    expect(screen.getByTestId("built-in-things-table").textContent).toContain(
      "SYSTEM 25",
    );
  });

  it("gives each section's page-size control its own id, so a label points at one control", () => {
    render(
      <>
        <CollectionSection
          title="Your things"
          label="Your things"
          noun="things"
          footerTestId="your-things-footer"
          columns={COLUMNS}
          rows={rows(2)}
          getRowKey={(row) => row.id}
        />
        <CollectionSection
          title="Built-in things"
          label="Built-in things"
          noun="things"
          footerTestId="built-in-things-footer"
          columns={COLUMNS}
          rows={rows(2, "SYSTEM")}
          getRowKey={(row) => row.id}
        />
      </>,
    );

    const ids = screen
      .getAllByLabelText("Rows")
      .map((control) => control.getAttribute("id"));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("CollectionSection, compact density", () => {
  type Dated = Row & { readonly createdAt: string };

  const dated = (count: number): Dated[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `u-${String(index).padStart(2, "0")}`,
      name: `Thing ${String(index).padStart(4, "0")}`,
      ownership: "USER",
      // The API's order is newest first, so the first row is the newest.
      createdAt: new Date(Date.UTC(2026, 8, 30 - index)).toISOString(),
    }));

  const DATED_COLUMNS: readonly DataTableColumn<Dated>[] = [
    { key: "name", header: "Name", cardRole: "identity", render: (row) => row.name },
    { key: "created", header: "Created", render: (row) => row.createdAt.slice(0, 10) },
  ];

  const SORTS: readonly CollectionSort<Dated>[] = [
    { id: "newest", label: "Newest", column: "created", direction: "desc", compare: byNewest((row) => row.createdAt) },
    { id: "name", label: "Name A–Z", column: "name", direction: "asc", compare: byName },
    { id: "name-desc", label: "Name Z–A", column: "name", direction: "desc", compare: (a, b) => byName(b, a) },
  ];

  function renderCompact(data: readonly Dated[], sorts = SORTS) {
    return render(
      <CollectionSection
        density="compact"
        title="Your things"
        label="Your things"
        noun="things"
        testId="your-things"
        tableTestId="your-things-table"
        footerTestId="your-things-footer"
        columns={DATED_COLUMNS}
        rows={data}
        getRowKey={(row) => row.id}
        searchText={(row) => row.name}
        sorts={sorts}
        emptyState={<p data-testid="nothing-yet">Nothing yet</p>}
      />,
    );
  }

  const names = () =>
    within(screen.getByTestId("your-things-table"))
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector('[data-column="name"]')?.textContent);

  it("publishes the density on the surface and the table, and keeps the surface on a phone", () => {
    renderCompact(dated(3));

    const section = screen.getByTestId("your-things");
    expect(section.getAttribute("data-density")).toBe("compact");
    expect(section.getAttribute("data-flush")).toBe("true");
    expect(screen.getByTestId("your-things-table").getAttribute("data-density")).toBe("compact");
  });

  it("counts its records beside the title, in words for assistive technology", () => {
    renderCompact(dated(1234).slice(0, 12));

    const count = screen.getByTestId("your-things-count");
    expect(count.textContent).toBe("12 things");
    // Beside the heading, not inside it: the heading stays the section's name.
    expect(screen.getByRole("heading", { name: "Your things" }).contains(count)).toBe(false);
  });

  it("writes large counts with separators and says how many of them a search matches", async () => {
    const user = userEvent.setup();
    renderCompact(dated(1200));

    expect(screen.getByTestId("your-things-count").textContent).toBe("1,200 things");
    await user.type(screen.getByRole("searchbox", { name: "Search things" }), "Thing 001");
    // Thing 0010 to Thing 0019.
    expect(screen.getByTestId("your-things-count").textContent).toBe("10 of 1,200 things");
  });

  it.each([
    [1, false],
    [10, false],
    [11, true],
    [60, true],
  ])("with %i records shows the footer: %s", (count, footer) => {
    renderCompact(dated(count));
    expect(screen.queryByTestId("your-things-footer") !== null).toBe(footer);
    expect(names()).toHaveLength(Math.min(count, 25));
  });

  it("opens at 25 rows and offers 10, 25, 50 and 100", async () => {
    const user = userEvent.setup();
    renderCompact(dated(60));

    const footer = screen.getByTestId("your-things-footer");
    const size = within(footer).getByLabelText("Rows") as HTMLSelectElement;
    expect([...size.options].map((option) => option.value)).toEqual(["10", "25", "50", "100"]);
    expect(size.value).toBe("25");
    expect(footer.textContent).toContain("Showing 1–25 of 60 things");

    await user.selectOptions(size, "10");
    expect(names()).toHaveLength(10);
    expect(footer.textContent).toContain("Page 1 of 6");
  });

  it("sorts from a column header and from the Sort control as one order", async () => {
    const user = userEvent.setup();
    renderCompact(dated(3));

    const header = (name: string) => screen.getByRole("columnheader", { name: new RegExp(name) });
    // The default order is its column's: Created, newest first.
    expect(header("Created").getAttribute("aria-sort")).toBe("descending");
    expect(header("Name").getAttribute("aria-sort")).toBeNull();
    expect(names()).toEqual(["Thing 0000", "Thing 0001", "Thing 0002"]);

    await user.click(within(header("Name")).getByRole("button"));
    expect(header("Name").getAttribute("aria-sort")).toBe("ascending");
    expect((screen.getByLabelText("Sort") as HTMLSelectElement).value).toBe("name");

    // A second press on the same header takes the column's other order.
    await user.click(within(header("Name")).getByRole("button"));
    expect(header("Name").getAttribute("aria-sort")).toBe("descending");
    expect(names()).toEqual(["Thing 0002", "Thing 0001", "Thing 0000"]);

    // The Sort control moves the headers with it.
    await user.selectOptions(screen.getByLabelText("Sort"), "newest");
    expect(header("Created").getAttribute("aria-sort")).toBe("descending");
    expect(header("Name").getAttribute("aria-sort")).toBeNull();
  });

  it("leaves a header that no order names as plain text", () => {
    renderCompact(dated(3), [
      { id: "newest", label: "Newest" },
      { id: "name", label: "Name A–Z", compare: byName },
    ]);

    expect(within(screen.getByTestId("your-things-table")).queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps its own empty state and shows no count when it holds nothing", () => {
    renderCompact([]);

    expect(screen.getByTestId("nothing-yet")).toBeDefined();
    expect(screen.queryByTestId("your-things-count")).toBeNull();
    expect(screen.queryByTestId("your-things-footer")).toBeNull();
  });
});

describe("CollectionSection, default density", () => {
  it("is unchanged: no count, the footer under two rows, and headers that do not sort", () => {
    render(
      <CollectionSection
        title="Your things"
        label="Your things"
        noun="things"
        testId="your-things"
        footerTestId="your-things-footer"
        columns={COLUMNS}
        rows={rows(2)}
        getRowKey={(row) => row.id}
        sorts={[
          { id: "newest", label: "Newest" },
          { id: "name", label: "Name A–Z", compare: byName },
        ]}
      />,
    );

    const section = screen.getByTestId("your-things");
    expect(section.getAttribute("data-density")).toBeNull();
    expect(screen.queryByTestId("your-things-count")).toBeNull();
    expect(screen.getByTestId("your-things-footer").textContent).toContain(
      "Showing 1–2 of 2 things",
    );
    expect(within(screen.getByRole("table")).queryAllByRole("button")).toHaveLength(0);
  });
});
