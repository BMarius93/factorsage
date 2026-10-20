import { act } from "@testing-library/react";
import { vi } from "vitest";

/**
 * A controllable `matchMedia` and page visibility for component tests (jsdom implements neither).
 *
 * It answers `(min-width: Npx)`, `(max-width: Npx)` and `(prefers-reduced-motion: reduce)` from the
 * state set here, and notifies every registered listener when that state changes — the way a browser
 * does when a window is resized across a breakpoint or a tab goes to the background. Call
 * `restore()` in `afterEach`.
 */
export type FakeViewport = {
  /** Resizes the viewport, notifying every query whose answer changed. */
  readonly resize: (width: number) => void;
  readonly setReducedMotion: (reduce: boolean) => void;
  /** Hides or shows the page, dispatching `visibilitychange`. */
  readonly setHidden: (hidden: boolean) => void;
  /** How many `change` listeners are registered right now, across every query. */
  readonly listenerCount: () => number;
  readonly restore: () => void;
};

export function installFakeViewport(
  initial: { width?: number; reducedMotion?: boolean } = {},
): FakeViewport {
  let width = initial.width ?? 1440;
  let reducedMotion = initial.reducedMotion ?? false;
  let hidden = false;
  const listeners = new Map<string, Set<() => void>>();

  const evaluate = (query: string): boolean => {
    if (query.includes("prefers-reduced-motion: reduce")) {
      return reducedMotion;
    }
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    return (
      (min === null || width >= Number(min[1])) &&
      (max === null || width <= Number(max[1]))
    );
  };

  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return evaluate(query);
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => {
        const set = listeners.get(query) ?? new Set();
        set.add(listener);
        listeners.set(query, set);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.get(query)?.delete(listener);
      },
    })),
  );

  const visibility = Object.getOwnPropertyDescriptor(
    Document.prototype,
    "visibilityState",
  );
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });

  const notify = (before: Map<string, boolean>) => {
    for (const [query, set] of listeners) {
      if (before.get(query) !== evaluate(query)) {
        for (const listener of [...set]) {
          listener();
        }
      }
    }
  };
  const snapshot = () =>
    new Map([...listeners.keys()].map((query) => [query, evaluate(query)]));

  return {
    resize: (next) =>
      act(() => {
        const before = snapshot();
        width = next;
        notify(before);
      }),
    setReducedMotion: (reduce) =>
      act(() => {
        const before = snapshot();
        reducedMotion = reduce;
        notify(before);
      }),
    setHidden: (next) =>
      act(() => {
        hidden = next;
        document.dispatchEvent(new Event("visibilitychange"));
      }),
    listenerCount: () =>
      [...listeners.values()].reduce((total, set) => total + set.size, 0),
    restore: () => {
      vi.unstubAllGlobals();
      delete (document as { visibilityState?: unknown }).visibilityState;
      if (visibility) {
        Object.defineProperty(
          Document.prototype,
          "visibilityState",
          visibility,
        );
      }
    },
  };
}
