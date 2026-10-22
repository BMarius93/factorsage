"use client";

import { useEffect, useRef, useState } from "react";

/** How far below the visible area the next page starts loading. */
export const AUTO_LOAD_DISTANCE_PX = 600;

/**
 * Loads the next page when a marker at the end of a feed comes within `AUTO_LOAD_DISTANCE_PX` of
 * the visible area — before the reader reaches the end, so it rarely shows a wait.
 *
 * The observer is created afresh whenever `enabled` turns on (after each page lands), so a feed
 * still shorter than the screen keeps filling until the caller turns it off; the caller decides
 * how many pages that may be. Where `IntersectionObserver` does not exist — or before the page has
 * hydrated — `supported` is false and the caller shows its button instead.
 */
export function useAutoLoad(enabled: boolean, load: () => void) {
  const [marker, setMarker] = useState<HTMLElement | null>(null);
  const [supported, setSupported] = useState(false);
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });
  useEffect(() => {
    setSupported(typeof IntersectionObserver !== "undefined");
  }, []);

  useEffect(() => {
    if (!enabled || !supported || marker === null) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          latest.current();
        }
      },
      { rootMargin: `0px 0px ${AUTO_LOAD_DISTANCE_PX}px 0px` },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [enabled, supported, marker]);

  return { marker: setMarker, supported };
}
