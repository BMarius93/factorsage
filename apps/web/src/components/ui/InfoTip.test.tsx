import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfoTip } from "./InfoTip";

function hoverCapable(capable: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: capable && query.includes("hover: hover"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InfoTip", () => {
  it("is a named button that reveals its explanation on click and describes itself while open", () => {
    hoverCapable(false);
    render(
      <InfoTip label="price vs value">Compares price with value.</InfoTip>,
    );
    const button = screen.getByRole("button", { name: "About price vs value" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(button);

    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe("Compares price with value.");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);

    fireEvent.click(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes on Escape and keeps focus on the button", () => {
    hoverCapable(false);
    render(<InfoTip label="allocation">Explained.</InfoTip>);
    const button = screen.getByRole("button", { name: "About allocation" });
    button.focus();
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes on a press outside", () => {
    hoverCapable(false);
    render(
      <div>
        <InfoTip label="allocation">Explained.</InfoTip>
        <p>Elsewhere</p>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "About allocation" }));
    act(() => {
      document
        .querySelector("p")
        ?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens on hover where the pointer can hover, and a click then keeps it open", () => {
    hoverCapable(true);
    render(<InfoTip label="allocation">Explained.</InfoTip>);
    const wrapper = screen.getByRole("button", {
      name: "About allocation",
    }).parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "About allocation" }));
    fireEvent.mouseLeave(wrapper);
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("does not open on the emulated hover of a touch screen", () => {
    hoverCapable(false);
    render(<InfoTip label="allocation">Explained.</InfoTip>);
    const button = screen.getByRole("button", { name: "About allocation" });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("sits fixed to the viewport, so a card that clips its overflow cannot cut it, and closes on scroll", () => {
    hoverCapable(false);
    render(<InfoTip label="allocation">Explained.</InfoTip>);
    fireEvent.click(screen.getByRole("button", { name: "About allocation" }));
    const tip = screen.getByRole("tooltip");
    expect(tip.style.top).not.toBe("");
    expect(tip.style.left).not.toBe("");
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
