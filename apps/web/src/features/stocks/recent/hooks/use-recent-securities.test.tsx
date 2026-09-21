import {
  STORAGE_CONSENT_KEY,
  STORAGE_CONSENT_VERSION,
  type StockSearchResultResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState } from "../../../auth/hooks/use-auth-session";
import { StorageConsentProvider } from "../../../legal/consent/use-storage-consent";
import {
  GUEST_RECENT_SECURITIES_KEY,
  readGuestRecentSecurityIds,
} from "../utils/guest-recent-securities";
import {
  RecentSecuritiesProvider,
  useRecentSecurities,
} from "./use-recent-securities";

let state: AuthState = { status: "loading" };

vi.mock("../../../auth/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state, signOut: vi.fn() }),
}));

function security(
  id: string,
  symbol: string,
  name: string,
): StockSearchResultResponse {
  return { id, symbol, name, exchangeCode: "NASDAQ" };
}

const AAPL = security("id-aapl", "AAPL", "Apple");
const NVDA = security("id-nvda", "NVDA", "NVIDIA");

/** Reads the provider's set and offers a button that records a view. */
function Probe({ record }: { readonly record?: StockSearchResultResponse }) {
  const { securities, record: onRecord } = useRecentSecurities();
  return (
    <div>
      <p data-testid="recents">
        {securities.map((entry) => entry.symbol).join(",")}
      </p>
      <button type="button" onClick={() => record && onRecord(record)}>
        record
      </button>
    </div>
  );
}

/**
 * Pre-records a storage decision, as a returning visitor's browser would hold it.
 *
 * A Guest's recents are optional storage, so every case that expects `localStorage` to be read or
 * written has to establish permission first — which is the property under test as much as it is
 * setup.
 */
function decideStorage(preferences: boolean) {
  window.localStorage.setItem(
    STORAGE_CONSENT_KEY,
    JSON.stringify({
      version: STORAGE_CONSENT_VERSION,
      preferences,
      decidedAt: new Date().toISOString(),
    }),
  );
}

function renderProvider(record?: StockSearchResultResponse) {
  return render(
    <StorageConsentProvider>
      <RecentSecuritiesProvider>
        <Probe {...(record ? { record } : {})} />
      </RecentSecuritiesProvider>
    </StorageConsentProvider>,
  );
}

function recents(): string {
  return screen.getByTestId("recents").textContent ?? "";
}

/** Resolves every `fetch` with the same rows. */
function respondWith(rows: StockSearchResultResponse[]) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => rows });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  state = { status: "loading" };
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("RecentSecuritiesProvider", () => {
  it("issues no request while the session is still resolving", async () => {
    const fetchMock = respondWith([]);
    renderProvider();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(recents()).toBe("");
  });

  it("loads an authenticated user's recents from the API, once", async () => {
    const fetchMock = respondWith([AAPL, NVDA]);
    state = {
      status: "authenticated",
      user: { id: "u1", email: "u@example.test", role: "USER", plan: "PRO" },
    };

    renderProvider();

    await waitFor(() => expect(recents()).toBe("AAPL,NVDA"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/recent-searches");
    // An authenticated caller's set is the database's; it never sends local ids.
    expect(url).not.toContain("ids=");
  });

  it("resolves a guest's stored ids against the catalog once storage is allowed", async () => {
    decideStorage(true);
    window.localStorage.setItem(
      GUEST_RECENT_SECURITIES_KEY,
      JSON.stringify(["id-nvda", "id-aapl"]),
    );
    const fetchMock = respondWith([NVDA, AAPL]);
    state = { status: "unauthenticated" };

    renderProvider();

    await waitFor(() => expect(recents()).toBe("NVDA,AAPL"));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "ids=id-nvda%2Cid-aapl",
    );
  });

  it("asks for nothing when a guest has stored nothing", async () => {
    const fetchMock = respondWith([]);
    state = { status: "unauthenticated" };

    renderProvider();

    await waitFor(() => expect(recents()).toBe(""));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists a guest's view locally and promotes it immediately once storage is allowed", async () => {
    decideStorage(true);
    respondWith([]);
    state = { status: "unauthenticated" };
    const user = userEvent.setup();

    renderProvider(NVDA);
    await user.click(screen.getByRole("button", { name: "record" }));

    expect(recents()).toBe("NVDA");
    expect(readGuestRecentSecurityIds()).toEqual(["id-nvda"]);
  });

  it("posts an authenticated view and promotes it without refetching", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [AAPL] })
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });
    vi.stubGlobal("fetch", fetchMock);
    state = {
      status: "authenticated",
      user: { id: "u1", email: "u@example.test", role: "USER", plan: "PRO" },
    };
    const user = userEvent.setup();

    renderProvider(NVDA);
    await waitFor(() => expect(recents()).toBe("AAPL"));

    await user.click(screen.getByRole("button", { name: "record" }));

    expect(recents()).toBe("NVDA,AAPL");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    // Nothing is stored locally for an authenticated user: their recents follow the account.
    expect(readGuestRecentSecurityIds()).toEqual([]);
  });

  it("promotes a re-viewed security rather than listing it twice", async () => {
    decideStorage(true);
    respondWith([]);
    state = { status: "unauthenticated" };
    const user = userEvent.setup();

    const tree = (record: StockSearchResultResponse) => (
      <StorageConsentProvider>
        <RecentSecuritiesProvider>
          <Probe record={record} />
        </RecentSecuritiesProvider>
      </StorageConsentProvider>
    );

    const { rerender } = render(tree(AAPL));
    await user.click(screen.getByRole("button", { name: "record" }));
    rerender(tree(NVDA));
    await user.click(screen.getByRole("button", { name: "record" }));
    rerender(tree(AAPL));
    await user.click(screen.getByRole("button", { name: "record" }));

    expect(recents()).toBe("AAPL,NVDA");
  });

  /**
   * The rules that make the guest recents lawful optional storage rather than a convenience
   * somebody forgot to ask about. Each of these is a separate way to get it wrong.
   */
  describe("optional storage is gated on the visitor's choice", () => {
    it("writes nothing to this browser before a guest has chosen", async () => {
      respondWith([]);
      state = { status: "unauthenticated" };
      const user = userEvent.setup();

      renderProvider(NVDA);
      await user.click(screen.getByRole("button", { name: "record" }));

      // The feature still works for this page session…
      expect(recents()).toBe("NVDA");
      // …and nothing reached the device.
      expect(window.localStorage.getItem(GUEST_RECENT_SECURITIES_KEY)).toBeNull();
    });

    it("writes nothing after a guest has refused", async () => {
      decideStorage(false);
      respondWith([]);
      state = { status: "unauthenticated" };
      const user = userEvent.setup();

      renderProvider(NVDA);
      await user.click(screen.getByRole("button", { name: "record" }));

      expect(recents()).toBe("NVDA");
      expect(window.localStorage.getItem(GUEST_RECENT_SECURITIES_KEY)).toBeNull();
    });

    it("does not read ids already on the device before a guest has chosen", async () => {
      // Storage left by an earlier visit, before this choice existed. It must not be read, and
      // it must not cost a request either.
      window.localStorage.setItem(
        GUEST_RECENT_SECURITIES_KEY,
        JSON.stringify(["id-nvda"]),
      );
      const fetchMock = respondWith([NVDA]);
      state = { status: "unauthenticated" };

      renderProvider();

      await waitFor(() => expect(recents()).toBe(""));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not read ids already on the device after a refusal", async () => {
      decideStorage(false);
      window.localStorage.setItem(
        GUEST_RECENT_SECURITIES_KEY,
        JSON.stringify(["id-nvda"]),
      );
      const fetchMock = respondWith([NVDA]);
      state = { status: "unauthenticated" };

      renderProvider();

      await waitFor(() => expect(recents()).toBe(""));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps storing an authenticated user's views on the server whatever the choice", async () => {
      // The choice governs *browser* storage. A signed-in user's recents are account data and
      // never touch `localStorage`, so refusing optional storage must not disable them.
      decideStorage(false);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => [AAPL] })
        .mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });
      vi.stubGlobal("fetch", fetchMock);
      state = {
        status: "authenticated",
        user: { id: "u1", email: "u@example.test", role: "USER", plan: "PRO" },
      };
      const user = userEvent.setup();

      renderProvider(NVDA);
      await waitFor(() => expect(recents()).toBe("AAPL"));
      await user.click(screen.getByRole("button", { name: "record" }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
      expect(window.localStorage.getItem(GUEST_RECENT_SECURITIES_KEY)).toBeNull();
    });
  });

  /**
   * Recording is convenience UI. A failed write must leave the page — and the navigation that
   * triggered it — completely undisturbed.
   */
  it("swallows a failed persistence call and still shows the view", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    state = {
      status: "authenticated",
      user: { id: "u1", email: "u@example.test", role: "USER", plan: "PRO" },
    };
    const user = userEvent.setup();
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);

    renderProvider(NVDA);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "record" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(recents()).toBe("NVDA");
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("shows nothing rather than failing when the recents request fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    state = {
      status: "authenticated",
      user: { id: "u1", email: "u@example.test", role: "USER", plan: "PRO" },
    };

    renderProvider();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(recents()).toBe("");
  });

  it("shows nothing, and reads no local ids, when the session cannot be resolved", async () => {
    window.localStorage.setItem(
      GUEST_RECENT_SECURITIES_KEY,
      JSON.stringify(["id-aapl"]),
    );
    const fetchMock = respondWith([AAPL]);
    state = { status: "error" };

    renderProvider();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(recents()).toBe("");
  });
});

describe("useRecentSecurities without a provider", () => {
  it("reports no recents instead of throwing", async () => {
    respondWith([]);
    const user = userEvent.setup();

    render(<Probe record={AAPL} />);
    await user.click(screen.getByRole("button", { name: "record" }));

    expect(recents()).toBe("");
  });
});
