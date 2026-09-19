"use client";

import { useEffect, useState } from "react";

/**
 * The current time, refreshed every `intervalMs` while the component is mounted (UI-048).
 *
 * A relative label computed once at render ("Updated 12 min ago") freezes while the page stays
 * open; reading the time from here keeps it true without refetching anything. The interval is
 * cleared on unmount.
 */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
