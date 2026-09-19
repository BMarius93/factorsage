"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getAuthUser } from "../api/auth-api";

/**
 * Sends a visitor who is already signed in on from `/login` or `/register` to where they were
 * going — the validated `next`, or the Dashboard — instead of showing a sign-in form that would
 * start a second session (UI-040).
 *
 * The form still renders while the session is read: a Guest, which is almost everyone here, never
 * waits for it. A `401` from `/auth/me` is the expected answer for a Guest, not an error. Returns
 * `true` once the redirect is under way, so the page can say so instead of flashing the form.
 */
export function useRedirectIfSignedIn(destination: string): boolean {
  const router = useRouter();
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    let active = true;
    getAuthUser()
      .then((user) => {
        if (active && user) {
          setRedirecting(true);
          router.replace(destination);
        }
      })
      // Unknown is treated as signed out: the form is the safe thing to show.
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [destination, router]);

  return redirecting;
}
