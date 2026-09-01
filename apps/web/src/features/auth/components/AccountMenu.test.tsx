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

let state: AuthState = { status: "loading" };

vi.mock("../hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state, signOut }),
}));

function authenticated(role: AuthUser["role"]): AuthState {
  return {
    status: "authenticated",
    user: { id: "1", email: "person@example.test", role },
  };
}

describe("AccountMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signOut.mockResolvedValue(undefined);
    state = authenticated("USER");
  });

  it("renders nothing until a session exists", () => {
    state = { status: "loading" };
    const { container } = render(<AccountMenu />);

    expect(container.firstChild).toBeNull();
  });

  it("shows the signed-in identity and role", async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);

    await user.click(screen.getByTestId("account-menu-trigger"));

    expect(screen.getByTestId("account-email").textContent).toBe(
      "person@example.test",
    );
    expect(screen.getByTestId("account-role").textContent).toBe("USER");
  });

  it("offers the admin route only to an ADMIN", async () => {
    const user = userEvent.setup();
    const view = render(<AccountMenu />);

    await user.click(screen.getByTestId("account-menu-trigger"));
    expect(screen.queryByRole("menuitem", { name: "Admin" })).toBeNull();

    state = authenticated("ADMIN");
    view.rerender(<AccountMenu />);

    expect(
      screen.getByRole("menuitem", { name: "Admin" }).getAttribute("href"),
    ).toBe("/admin");
  });

  it("signs out and returns the browser to the sign-in page", async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);

    await user.click(screen.getByTestId("account-menu-trigger"));
    await user.click(screen.getByTestId("sign-out"));

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
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
