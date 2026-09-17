import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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
