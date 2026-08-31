import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppTopbar } from "./AppTopbar";
import { PRIMARY_NAV_ITEMS } from "./navigation";

vi.mock("next/navigation", () => ({
  usePathname: () => "/lists",
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

/**
 * The topbar composes the stock-search feature. These assertions exist so adding it cannot quietly
 * displace the brand, the primary navigation, or the account slot.
 */
describe("AppTopbar", () => {
  it("keeps the brand link, primary navigation and account slot alongside the search", () => {
    render(<AppTopbar actions={<button type="button">Account</button>} />);

    expect(screen.getByRole("link", { name: "FactorSage home" })).toBeDefined();

    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const item of PRIMARY_NAV_ITEMS) {
      expect(nav.querySelector(`a[href="${item.href}"]`)).not.toBeNull();
    }

    expect(screen.getByRole("button", { name: "Account" })).toBeDefined();
    expect(
      screen.getByRole("combobox", { name: "Search stocks" }),
    ).toBeDefined();
  });

  it("still marks the active destination", () => {
    render(<AppTopbar />);

    const active = screen
      .getByRole("navigation", { name: "Primary" })
      .querySelector('a[aria-current="page"]');

    expect(active?.getAttribute("href")).toBe("/lists");
  });
});
