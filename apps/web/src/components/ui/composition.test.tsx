import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageContainer } from "../layout/PageContainer";
import { PageHeader } from "./PageHeader";
import { SectionCard } from "./SectionCard";

/**
 * The composition contract from `ai/architecture/v1-visual-parity.md`: which variant a page
 * asks for, and what each one means. These assert the contract, not pixel values — the
 * numbers live in `styles/tokens.css` and are meant to be tuned there.
 */
describe("PageHeader variants", () => {
  it("frames the header in a surface by default, the way every collection opens", () => {
    render(<PageHeader title="Lists" testId="header" />);

    expect(screen.getByTestId("header").getAttribute("data-variant")).toBe(
      "surface",
    );
  });

  it("drops the frame for an editor, where the form surface is the container", () => {
    render(<PageHeader title="New backtest" variant="plain" testId="header" />);

    expect(screen.getByTestId("header").getAttribute("data-variant")).toBe(
      "plain",
    );
  });

  it("marks a result-first screen so the title takes the display size", () => {
    render(<PageHeader title="Deep value" variant="hero" testId="header" />);

    expect(screen.getByTestId("header").getAttribute("data-variant")).toBe(
      "hero",
    );
  });

  it("renders exactly one h1 whichever variant it wears", () => {
    render(<PageHeader title="Monitors" variant="hero" />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("keeps a page-level fact separate from the page's actions", () => {
    render(
      <PageHeader
        title="AAPL"
        aside={<span>$332.27</span>}
        actions={<button type="button">Edit</button>}
      />,
    );

    // The quote is reported, not offered: it must not become a control.
    expect(screen.getByText("$332.27").closest("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();
  });
});

describe("SectionCard", () => {
  it("is an ordinary flat surface unless a screen asks for the hero", () => {
    render(
      <SectionCard testId="plain" ariaLabel="Rows">
        <p>body</p>
      </SectionCard>,
    );

    expect(screen.getByTestId("plain").getAttribute("data-hero")).toBeNull();
  });

  it("marks the one outcome hero in the product", () => {
    render(
      <SectionCard hero testId="hero" ariaLabel="Result">
        <p>body</p>
      </SectionCard>,
    );

    expect(screen.getByTestId("hero").getAttribute("data-hero")).toBe("true");
  });

  it("publishes flush on the surface, so it can dissolve on a phone", () => {
    render(
      <SectionCard flush testId="collection" ariaLabel="Stock lists">
        <p>table</p>
      </SectionCard>,
    );

    expect(screen.getByTestId("collection").getAttribute("data-flush")).toBe(
      "true",
    );
  });

  it("renders no heading when a collection's title already belongs to the page", () => {
    render(
      <SectionCard testId="untitled" ariaLabel="Stock lists">
        <p>table</p>
      </SectionCard>,
    );

    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("PageContainer", () => {
  it("lets data surfaces use the screen by default", () => {
    const { container } = render(
      <PageContainer>
        <p>table</p>
      </PageContainer>,
    );

    expect(container.firstElementChild?.getAttribute("data-width")).toBe(
      "data",
    );
  });

  it("caps a form or prose route at a readable measure", () => {
    const { container } = render(
      <PageContainer width="reading">
        <p>form</p>
      </PageContainer>,
    );

    expect(container.firstElementChild?.getAttribute("data-width")).toBe(
      "reading",
    );
  });
});
