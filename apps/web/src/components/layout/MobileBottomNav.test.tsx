import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";
import { PRIMARY_NAV_ITEMS } from "./navigation";
import { useUnsavedChangesGuard } from "./unsaved-changes";

/** Destinations a tap actually reached, once the guard let it through. */
const { navigated } = vi.hoisted(() => ({ navigated: [] as string[] }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/strategies/new",
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

function GuardedPage() {
  useUnsavedChangesGuard(true, "Leave and discard?");
  return null;
}

afterEach(() => {
  navigated.length = 0;
  vi.restoreAllMocks();
});

/**
 * The bottom navigation is the only primary navigation a phone has, so it must honour the same
 * unsaved-changes guard as the desktop topbar.
 */
describe("MobileBottomNav", () => {
  it("keeps a page's unsaved work from being discarded by a tap", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <>
        <GuardedPage />
        <MobileBottomNav />
      </>,
    );

    await user.click(screen.getByRole("link", { name: "Backtests" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(navigated).toEqual([]);

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("link", { name: "Backtests" }));
    expect(navigated).toEqual(["/backtests"]);
  });

  it("guards every primary destination", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <>
        <GuardedPage />
        <MobileBottomNav />
      </>,
    );

    for (const item of PRIMARY_NAV_ITEMS) {
      screen.getByRole("link", { name: item.label }).click();
    }
    expect(navigated).toEqual([]);
  });

  it("leaves navigation alone when nothing is unsaved", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm");
    render(<MobileBottomNav />);

    await user.click(screen.getByRole("link", { name: "Lists" }));

    expect(confirm).not.toHaveBeenCalled();
    expect(navigated).toEqual(["/lists"]);
  });
});
