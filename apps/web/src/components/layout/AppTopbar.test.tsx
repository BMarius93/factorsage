import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTopbar } from "./AppTopbar";
import { PRIMARY_NAV_ITEMS } from "./navigation";
import { useUnsavedChangesGuard } from "./unsaved-changes";

/** Destinations a click actually reached, once the guard let it through. */
const { navigated } = vi.hoisted(() => ({ navigated: [] as string[] }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/lists",
  useRouter: () => ({ push: vi.fn() }),
}));

/**
 * Stands in for Next's client-side navigation: `onNavigate` runs first and may cancel it. jsdom
 * cannot follow a real `<a>`, so a reached destination is recorded instead.
 */
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    onNavigate,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    onNavigate?: (event: { preventDefault: () => void }) => void;
  }) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        event.preventDefault();
        let cancelled = false;
        onNavigate?.({
          preventDefault: () => {
            cancelled = true;
          },
        });
        if (!cancelled) {
          navigated.push(href);
        }
      }}
    >
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
function GuardedPage() {
  useUnsavedChangesGuard(true, "Leave and discard?");
  return null;
}

afterEach(() => {
  navigated.length = 0;
  vi.restoreAllMocks();
});

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

  it("keeps a page's unsaved work from being discarded by a navigation link", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <>
        <GuardedPage />
        <AppTopbar />
      </>,
    );

    await user.click(screen.getByRole("link", { name: "Backtests" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(navigated).toEqual([]);

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("link", { name: "Backtests" }));
    expect(navigated).toEqual(["/backtests"]);
  });

  it("guards the brand link and every primary destination", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <>
        <GuardedPage />
        <AppTopbar />
      </>,
    );

    const links = [
      screen.getByRole("link", { name: "FactorSage home" }),
      ...PRIMARY_NAV_ITEMS.map((item) =>
        screen.getByRole("link", { name: item.label }),
      ),
    ];
    for (const link of links) {
      link.click();
    }
    expect(navigated).toEqual([]);
  });
});
