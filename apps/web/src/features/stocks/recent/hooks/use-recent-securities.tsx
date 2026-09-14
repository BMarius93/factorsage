"use client";

import {
  RECENT_SECURITY_LIMIT,
  type StockSearchResultResponse,
} from "@intrinsic/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuthSession } from "../../../auth/hooks/use-auth-session";
import {
  fetchRecentSearches,
  recordSecurityView,
} from "../api/recent-searches-api";
import {
  readGuestRecentSecurityIds,
  rememberGuestRecentSecurityId,
} from "../utils/guest-recent-securities";

export type RecentSecurities = {
  /** Newest first, already resolved against the catalog. Empty until the first load lands. */
  readonly securities: readonly StockSearchResultResponse[];
  /** Records a viewed security and promotes it to the front. Never rejects. */
  readonly record: (security: StockSearchResultResponse) => void;
};

/**
 * The default is a working, empty implementation rather than a thrown error.
 *
 * Recent searches are convenience chrome: a surface rendered outside the provider — a test
 * mounting the search box on its own, a future shell that does not carry one — should show the
 * dropdown it has always shown, not crash the topbar.
 */
const EMPTY: RecentSecurities = { securities: [], record: () => {} };

const RecentSecuritiesContext = createContext<RecentSecurities>(EMPTY);

/** Newest first, no duplicates, at most `RECENT_SECURITY_LIMIT` — mirrors the server's own rule. */
function promote(
  security: StockSearchResultResponse,
  current: readonly StockSearchResultResponse[],
): StockSearchResultResponse[] {
  return [
    security,
    ...current.filter((entry) => entry.id !== security.id),
  ].slice(0, RECENT_SECURITY_LIMIT);
}

/**
 * Holds the recently viewed securities for the whole authenticated shell.
 *
 * One loader for the application, not one per dropdown: the set is read once when the session
 * resolves and then maintained locally, so opening and closing the search box repeatedly costs
 * nothing and the dropdown never opens into a spinner waiting on a request focus just triggered.
 *
 * Recording a view updates this state from the security the page already resolved, so the list is
 * correct immediately and the persistence call is pure background work. That is also what keeps a
 * failed write harmless: the user still sees what they just viewed, and the next successful write
 * reconciles the server.
 */
export function RecentSecuritiesProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { state } = useAuthSession();
  const [securities, setSecurities] = useState<
    readonly StockSearchResultResponse[]
  >([]);
  // Authentication decides where a view is persisted, and `record` must not be rebuilt (and so
  // re-fire its caller's effect) every time the session object changes identity.
  const authenticated = state.status === "authenticated";
  const authenticatedRef = useRef(authenticated);
  authenticatedRef.current = authenticated;

  useEffect(() => {
    if (state.status === "loading") {
      return;
    }
    // An unresolvable session is treated as no recents rather than as a guest: reading this
    // browser's local ids for a user who may well be signed in would show them somebody else's.
    if (state.status === "error") {
      setSecurities([]);
      return;
    }

    const controller = new AbortController();
    const ids =
      state.status === "authenticated" ? [] : readGuestRecentSecurityIds();
    // A guest with nothing stored has nothing to resolve, so the dropdown costs no request at all.
    if (state.status === "unauthenticated" && ids.length === 0) {
      setSecurities([]);
      return;
    }

    fetchRecentSearches(ids, { signal: controller.signal })
      .then((loaded) => {
        if (!controller.signal.aborted) {
          setSecurities(loaded);
        }
      })
      .catch(() => {
        // Convenience UI: an unreachable API costs the recent section, nothing else.
      });

    return () => controller.abort();
  }, [state.status]);

  const record = useCallback((security: StockSearchResultResponse) => {
    setSecurities((current) => promote(security, current));
    if (!authenticatedRef.current) {
      rememberGuestRecentSecurityId(security.id);
      return;
    }
    void recordSecurityView(security.id).catch(() => {
      // Deliberately swallowed. Recording a view must never interrupt the page that triggered it,
      // and there is no action the user could take about it.
    });
  }, []);

  const value = useMemo<RecentSecurities>(
    () => ({ securities, record }),
    [securities, record],
  );

  return (
    <RecentSecuritiesContext.Provider value={value}>
      {children}
    </RecentSecuritiesContext.Provider>
  );
}

export function useRecentSecurities(): RecentSecurities {
  return useContext(RecentSecuritiesContext);
}

/**
 * Records a Stock Details view once per security.
 *
 * Called from the page itself rather than from the search dropdown, which is what makes "recent
 * searches" mean *recently viewed*: reaching a stock from a list, a monitor, a backtest or a pasted
 * URL records it exactly like reaching it from search, and merely typing, highlighting or being
 * shown a suggestion records nothing.
 */
export function useRecordSecurityView(
  security: StockSearchResultResponse | undefined,
): void {
  const { record } = useRecentSecurities();
  const securityId = security?.id;
  // The identity row is re-created on every details refetch; only a different security is a new
  // view, so the effect keys on the id and reads the row through a ref.
  const latest = useRef(security);
  latest.current = security;

  useEffect(() => {
    if (securityId && latest.current) {
      record(latest.current);
    }
  }, [record, securityId]);
}
