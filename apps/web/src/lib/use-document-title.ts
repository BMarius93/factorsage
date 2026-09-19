"use client";

import { useEffect } from "react";

const SUFFIX = " · FactorSage";

/**
 * Names the tab after the entity once it has loaded (UI-055): "Blue chips · FactorSage" rather
 * than the route's generic "List · FactorSage", which is what the server-rendered metadata can
 * say before the client has the record. Restores the previous title when the page unmounts.
 */
export function useDocumentTitle(name: string | null | undefined): void {
  useEffect(() => {
    if (!name) {
      return;
    }
    const previous = document.title;
    document.title = `${name}${SUFFIX}`;
    return () => {
      document.title = previous;
    };
  }, [name]);
}
