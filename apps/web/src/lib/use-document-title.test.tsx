import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDocumentTitle } from "./use-document-title";

function Titled({ name }: { readonly name: string | null }) {
  useDocumentTitle(name);
  return null;
}

describe("useDocumentTitle (UI-055)", () => {
  it("names the tab after the loaded entity and restores the route title on leaving", () => {
    document.title = "List · FactorSage";
    const { rerender, unmount } = render(<Titled name={null} />);
    expect(document.title).toBe("List · FactorSage");

    rerender(<Titled name="Blue chips" />);
    expect(document.title).toBe("Blue chips · FactorSage");

    unmount();
    expect(document.title).toBe("List · FactorSage");
  });
});
