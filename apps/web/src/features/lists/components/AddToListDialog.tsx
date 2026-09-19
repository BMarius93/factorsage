"use client";

import type { StockListSummaryResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EntitlementNotice } from "../../../components/ui/EntitlementNotice";
import { EntitySelect } from "../../../components/ui/EntitySelect";
import forms from "../../../components/ui/forms.module.css";
import { Modal } from "../../../components/ui/Modal";
import { Notice } from "../../../components/ui/Notice";
import {
  isEntitlementError,
  requestFailureMessage,
} from "../../../lib/api/entitlement-errors";
import {
  addStockListItems,
  fetchStockList,
  fetchStockLists,
} from "../api/stock-lists-api";

type AddToListDialogProps = {
  readonly security: {
    readonly id: string;
    readonly symbol: string;
  };
  readonly onClose: () => void;
};

type Membership = "unknown" | "checking" | "member" | "not-member";

/**
 * Adds the stock being researched to one of the caller's own lists (UI-018).
 *
 * Only the caller's own lists are offered: built-ins are read-only. Choosing a list checks whether
 * the stock is already in it before anything is sent, so the dialog says "already in" instead of
 * reporting a no-op as a success. The API still decides — its add is idempotent and it enforces the
 * plan's per-list limit, whose refusal is shown in its own words.
 */
export function AddToListDialog({ security, onClose }: AddToListDialogProps) {
  const [lists, setLists] = useState<readonly StockListSummaryResponse[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const [listId, setListId] = useState("");
  const [membership, setMembership] = useState<Membership>("unknown");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{
    readonly message: string;
    readonly plan: boolean;
  } | null>(null);
  const [added, setAdded] = useState<StockListSummaryResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchStockLists({ signal: controller.signal })
      .then((loaded) => {
        setLists(loaded.filter((list) => list.ownership !== "SYSTEM"));
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setStatus("error");
        }
      });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    if (listId === "") {
      return;
    }
    const controller = new AbortController();
    fetchStockList(listId, { signal: controller.signal })
      .then((detail) =>
        setMembership(
          detail.items.some((item) => item.security.id === security.id)
            ? "member"
            : "not-member",
        ),
      )
      // Unknown is safe: the add is idempotent, so the button stays usable.
      .catch(() => {
        if (!controller.signal.aborted) {
          setMembership("unknown");
        }
      });
    return () => controller.abort();
  }, [listId, security.id]);

  const chosen = lists.find((list) => list.id === listId);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!chosen || pending || membership === "member") {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await addStockListItems(chosen.id, { securityIds: [security.id] });
      setAdded(chosen);
    } catch (caught) {
      setError({
        message: requestFailureMessage(
          caught,
          "The stock could not be added right now. Try again in a moment.",
        ),
        plan: isEntitlementError(caught),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title={`Add ${security.symbol} to a list`}
      onClose={onClose}
      testId="add-to-list-dialog"
    >
      {status === "loading" ? (
        <p className={forms.hint}>Loading your lists…</p>
      ) : null}

      {status === "error" ? (
        <div className={forms.form}>
          <p className={forms.error} role="alert">
            Your lists could not be loaded. This is usually temporary.
          </p>
          <div className={forms.actions}>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={() => {
                setStatus("loading");
                setAttempt((current) => current + 1);
              }}
            >
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {status === "ready" && lists.length === 0 ? (
        <div className={forms.form} data-testid="add-to-list-no-lists">
          <Notice>
            <p>
              You do not have a list of your own yet. Built-in lists are
              maintained by FactorSage and cannot be changed.
            </p>
          </Notice>
          <div className={forms.actions}>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={onClose}
            >
              Cancel
            </button>
            <Link className={forms.primaryButton} href="/lists?new=1">
              Create a list
            </Link>
          </div>
        </div>
      ) : null}

      {status === "ready" && lists.length > 0 && added ? (
        <div className={forms.form}>
          <Notice tone="success" announce="status" testId="add-to-list-added">
            <p>
              {security.symbol} is now in <strong>{added.name}</strong>.
            </p>
          </Notice>
          <div className={forms.actions}>
            <Link className={forms.secondaryButton} href={`/lists/${added.id}`}>
              Open list
            </Link>
            <button
              type="button"
              className={forms.primaryButton}
              onClick={onClose}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}

      {status === "ready" && lists.length > 0 && !added ? (
        <form className={forms.form} onSubmit={submit} noValidate>
          <div className={forms.field}>
            <label className={forms.label} htmlFor="add-to-list-list">
              List
            </label>
            <EntitySelect
              id="add-to-list-list"
              kind="list"
              testId="add-to-list-select"
              items={lists}
              value={listId}
              onValueChange={(id) => {
                setListId(id);
                setMembership(id === "" ? "unknown" : "checking");
                setError(null);
              }}
            />
            {membership === "member" && chosen ? (
              <p className={forms.hint} data-testid="add-to-list-already">
                {security.symbol} is already in {chosen.name}.
              </p>
            ) : (
              <p className={forms.hint}>
                Added as always eligible. Set its membership period on the list
                afterwards if it needs one.
              </p>
            )}
          </div>

          {error ? (
            error.plan ? (
              <EntitlementNotice
                testId="add-to-list-error"
                message={error.message}
              />
            ) : (
              <p
                className={forms.error}
                role="alert"
                data-testid="add-to-list-error"
              >
                {error.message}
              </p>
            )
          ) : null}

          <div className={forms.actions}>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={forms.primaryButton}
              data-testid="add-to-list-submit"
              disabled={
                !chosen ||
                pending ||
                membership === "member" ||
                membership === "checking"
              }
            >
              {pending ? "Adding…" : "Add to list"}
            </button>
          </div>
        </form>
      ) : null}
    </Modal>
  );
}
