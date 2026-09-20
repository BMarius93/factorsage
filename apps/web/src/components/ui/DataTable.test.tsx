import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable, type DataTableColumn } from "./DataTable";

type Row = { readonly id: string; readonly name: string; readonly size: number };

const ROWS: readonly Row[] = [
  { id: "a", name: "Alpha", size: 3 },
  { id: "b", name: "Beta", size: 12 },
];

const COLUMNS: readonly DataTableColumn<Row>[] = [
  {
    key: "name",
    header: "Name",
    cardRole: "identity",
    render: (row) => row.name,
  },
  {
    key: "state",
    header: "State",
    cardRole: "status",
    render: () => "Enabled",
  },
  {
    key: "strategy",
    header: "Strategy",
    cardRole: "links",
    render: () => "Deep value",
  },
  {
    key: "size",
    header: "Size",
    align: "right",
    numeric: true,
    render: (row) => String(row.size),
  },
  {
    key: "note",
    header: "Note",
    cardRole: "hidden",
    render: () => "desktop only",
  },
];

function renderTable(overrides: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  return render(
    <DataTable
      label="Things"
      columns={COLUMNS}
      rows={ROWS}
      getRowKey={(row) => row.id}
      rowTestId="thing-row"
      {...overrides}
    />,
  );
}

describe("DataTable", () => {
  it("exposes real table semantics with one row per record", () => {
    renderTable();

    const table = screen.getByRole("table", { name: "Things" });
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2
    expect(within(table).getAllByRole("columnheader")).toHaveLength(
      COLUMNS.length,
    );
    // The desktop table and the mobile card are the same DOM: a record must never be
    // rendered twice, or every row count and every screen reader would double it.
    expect(screen.getAllByTestId("thing-row")).toHaveLength(2);
    expect(screen.getAllByText("Alpha")).toHaveLength(1);
  });

  it("tags each cell with the region of the mobile card it belongs to", () => {
    const { container } = renderTable();
    const row = screen.getAllByTestId("thing-row")[0]!;

    expect(
      row.querySelector('[data-card="identity"]')?.textContent,
    ).toContain("Alpha");
    expect(row.querySelector('[data-card="status"]')?.textContent).toContain(
      "Enabled",
    );
    expect(row.querySelector('[data-card="links"]')?.textContent).toContain(
      "Deep value",
    );
    // Unmarked columns are facts, and a fact carries its column name as a card label.
    expect(row.querySelector('[data-card="fact"]')?.textContent).toContain(
      "Size",
    );
    expect(container.querySelectorAll('td[data-card="hidden"]')).toHaveLength(2);
  });

  it("marks numeric columns so digits align", () => {
    renderTable();
    const row = screen.getAllByTestId("thing-row")[1]!;
    const numeric = row.querySelector('[data-numeric="true"]');
    expect(numeric?.getAttribute("data-align")).toBe("right");
    expect(numeric?.textContent).toContain("12");
  });

  it("renders the empty state instead of an empty table", () => {
    renderTable({ rows: [], emptyState: <p>Nothing here</p> });

    expect(screen.getByText("Nothing here")).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("forwards a row click to the row's own identity link", () => {
    const navigated: string[] = [];
    const columns: readonly DataTableColumn<Row>[] = [
      {
        key: "name",
        header: "Name",
        cardRole: "identity",
        render: (row) => (
          <a
            href={`/things/${row.id}`}
            onClick={(event) => {
              event.preventDefault();
              navigated.push(`/things/${row.id}`);
            }}
          >
            {row.name}
          </a>
        ),
      },
      {
        key: "actions",
        header: "Actions",
        cardRole: "actions",
        render: () => <button type="button">Delete</button>,
      },
    ];
    render(
      <DataTable
        label="Things"
        columns={columns}
        rows={ROWS}
        getRowKey={(row) => row.id}
        rowTestId="thing-row"
        clickableRows
      />,
    );

    const row = screen.getAllByTestId("thing-row")[0]!;
    // Clicking dead space in the row opens what the row identifies.
    fireEvent.click(row);
    expect(navigated).toEqual(["/things/a"]);

    // A click that lands on a control belongs to that control, not to the row.
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(navigated).toEqual(["/things/a"]);
  });

  it("leaves rows inert when they are not marked clickable", () => {
    renderTable();
    expect(
      screen.getAllByTestId("thing-row")[0]!.getAttribute("data-clickable"),
    ).toBeNull();
  });

  it("reports the sorted column to assistive technology", () => {
    const columns: readonly DataTableColumn<Row>[] = [
      { ...COLUMNS[0]!, sortable: true },
      COLUMNS[3]!,
    ];
    render(
      <DataTable
        label="Things"
        columns={columns}
        rows={ROWS}
        getRowKey={(row) => row.id}
        sort={{ key: "name", direction: "asc" }}
        onSortChange={() => {}}
      />,
    );

    const header = screen.getByRole("columnheader", { name: /Name/ });
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByRole("button", { name: /Name/ })).toBeDefined();
  });

  it("carries sizing hints as custom properties so they never constrain a phone card", () => {
    render(
      <DataTable
        label="Sized"
        columns={[
          { key: "name", header: "Name", cardRole: "identity", minWidth: "7rem", render: (row: Row) => row.name },
          { key: "why", header: "Why", stacked: true, foldIntermediate: true, render: () => "Because" },
        ]}
        rows={ROWS}
        getRowKey={(row) => row.id}
        rowTestId="sized-row"
      />,
    );
    const row = screen.getAllByTestId("sized-row")[0]!;
    const identity = row.querySelector<HTMLElement>('[data-card="identity"]')!;
    expect(identity.style.getPropertyValue("--column-min-width")).toBe("7rem");
    expect(identity.style.minWidth).toBe("");
    const why = row.querySelector<HTMLElement>('td[data-card="fact"]')!;
    expect(why.getAttribute("data-stacked")).toBe("true");
    expect(why.getAttribute("data-fold")).toBe("true");
    expect(
      screen.getByRole("columnheader", { name: "Why" }).getAttribute("data-fold"),
    ).toBe("true");
  });
});
