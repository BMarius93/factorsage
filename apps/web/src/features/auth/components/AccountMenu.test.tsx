import type { AuthUser } from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState } from "../hooks/use-auth-session";
import { AccountMenu } from "./AccountMenu";

const replace = vi.fn();
const refresh = vi.fn();
const signOut = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
  usePathname: () => pathname,
}));

let pathname = "/dashboard";

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

let state: AuthState = { status: "loading" };

vi.mock("../hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state, signOut }),
}));

function authenticated(role: AuthUser["role"]): AuthState {
  return {
    status: "authenticated",
    user: { id: "1", email: "person@example.test", role, plan: "PRO" },
  };
}

describe("AccountMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signOut.mockResolvedValue(undefined);
    state = authenticated("USER");
  });

  it("offers a Guest pricing and sign-in, and nothing account-shaped", () => {
    state = { status: "unauthenticated" };
    render(<AccountMenu />);

    expect(screen.getByTestId("pricing-link").getAttribute("href")).toBe(
      "/pricing",
    );
    expect(screen.getByTestId("sign-in-link").getAttribute("href")).toBe(
      "/login",
    );
    expect(screen.queryByTestId("account-menu-trigger")).toBeNull();
  });

  it("returns a Guest who signs in from the topbar to the page they were on (UI-042)", () => {
    state = { status: "unauthenticated" };
    pathname = "/strategies/abc";
    render(<AccountMenu />);
    expect(screen.getByTestId("sign-in-link").getAttribute("href")).toBe(
      "/login?next=%2Fstrategies%2Fabc",
    );
    pathname = "/dashboard";
  });

  it("renders nothing until a session exists", () => {
    state = { status: "loading" };
    const { container } = render(<AccountMenu />);

    expect(container.firstChild).toBeNull();
  });

  it("shows the signed-in identity and plan, and no internal role for a customer", async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);

    await user.click(screen.getByTestId("account-menu-trigger"));

    expect(screen.getByTestId("account-email").textContent).toBe(
      "person@example.test",
    );
    // The plan is what the customer bought (UI-024); "USER" meant nothing to them.
    expect(screen.getByTestId("account-plan").textContent).toBe("Pro");
    expect(screen.queryByTestId("account-role")).toBeNull();
  });

  it("is an honest disclosure: a labelled group, Tab-reachable, closed by Escape back to its button (UI-053)", async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);
    const trigger = screen.getByTestId("account-menu-trigger");

    await user.click(trigger);
    expect(trigger.getAttribute("aria-haspopup")).toBeNull();
    const panel = screen.getByRole("group", { name: "Account" });
    expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
    expect(screen.queryByRole("menu")).toBeNull();

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("link", { name: "Plan and billing" }),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("account-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when the keyboard tabs past its last item", async () => {
    const user = userEvent.setup();
    render(
      <>
        <AccountMenu />
        <button type="button">Next on the page</button>
      </>,
    );
    await user.click(screen.getByTestId("account-menu-trigger"));
    await user.tab(); // Plan and billing
    await user.tab(); // Sign out
    await user.tab(); // Sign out everywhere
    await user.tab(); // leaves the panel
    expect(document.activeElement?.textContent).toBe("Next on the page");
    expect(screen.queryByTestId("account-menu")).toBeNull();
  });

  it("marks an administrator as such beside the plan", async () => {
    const user = userEvent.setup();
    state = authenticated("ADMIN");
    render(<AccountMenu />);

    await user.click(screen.getByTestId("account-menu-trigger"));
    expect(screen.getByTestId("account-plan").textContent).toBe("Pro");
    expect(screen.getByTestId("account-role").textContent).toBe("Admin");
  });

  it("offers the admin route only to an ADMIN", async () => {
    const user = userEvent.setup();
    const view = render(<AccountMenu />);

    await user.click(screen.getByTestId("account-menu-trigger"));
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();

    state = authenticated("ADMIN");
    view.rerender(<AccountMenu />);

    expect(
      screen.getByRole("link", { name: "Admin" }).getAttribute("href"),
    ).toBe("/admin");
  });

  it("signs out and returns the browser to the sign-in page", async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);

    await user.click(screen.getByTestId("account-menu-trigger"));
    await user.click(screen.getByTestId("sign-out"));

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(signOut).toHaveBeenCalledWith({ everywhere: false });
    expect(replace).toHaveBeenCalledWith("/login");
    expect(screen.queryByTestId("account-menu")).toBeNull();
  });

  it("signs out everywhere and returns the browser to the sign-in page", async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);

    await user.click(screen.getByTestId("account-menu-trigger"));
    await user.click(
      screen.getByRole("button", { name: "Sign out everywhere" }),
    );

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(signOut).toHaveBeenCalledWith({ everywhere: true });
    expect(replace).toHaveBeenCalledWith("/login");
    expect(screen.queryByTestId("account-menu")).toBeNull();
  });

  it("keeps the session visible when signing out fails", async () => {
    signOut.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    render(<AccountMenu />);

    await user.click(screen.getByTestId("account-menu-trigger"));
    await user.click(screen.getByTestId("sign-out"));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(replace).not.toHaveBeenCalled();
  });
});
