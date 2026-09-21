"use client";

import type { LegalRequestReceipt } from "@intrinsic/contracts";
import { useEffect, useState } from "react";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SectionCard } from "../../../components/ui/SectionCard";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { fetchLegalRequests } from "../api/legal-api";
import { LegalRequestReceiptPanel } from "./LegalRequestReceipt";

/**
 * The account's own submitted requests, newest first.
 *
 * This is the third way a receipt stays durable: on screen at the time, saved as a file, and
 * findable again here. Nothing is promised by email, because there is no approved monitored
 * mailbox to send from (`O2`).
 *
 * Scoped to the caller by the server, so there is nothing here to scope on the client.
 */
export function LegalRequestHistory() {
  const { state: session } = useAuthSession();
  const [requests, setRequests] = useState<
    readonly LegalRequestReceipt[] | null
  >(null);

  const authenticated = session.status === "authenticated";

  useEffect(() => {
    if (!authenticated) {
      setRequests(null);
      return;
    }
    const controller = new AbortController();
    fetchLegalRequests({ signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) {
          setRequests(response.requests);
        }
      })
      .catch(() => {
        // A failed read costs the history list and nothing else: submitting still works, and the
        // receipt shown at submission time is the copy that matters.
        if (!controller.signal.aborted) {
          setRequests([]);
        }
      });
    return () => controller.abort();
  }, [authenticated]);

  if (!authenticated || requests === null) {
    return null;
  }

  if (requests.length === 0) {
    return (
      <SectionCard title="Your requests" testId="legal-request-history">
        <EmptyState
          variant="compact"
          title="No requests yet"
          body="Anything you submit will appear here with its reference and the time it was received."
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Your requests"
      caption="Every request you have submitted, newest first. Quote a reference if you follow up."
      testId="legal-request-history"
    >
      <div>
        {requests.map((receipt) => (
          <LegalRequestReceiptPanel key={receipt.reference} receipt={receipt} />
        ))}
      </div>
    </SectionCard>
  );
}
