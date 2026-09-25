"use client";

import {
  ALTERNATIVE_DATA_LOOKBACKS,
  CONGRESS_CHAMBER_FILTERS,
  CONGRESS_CHAMBER_FILTER_LABELS,
  CONGRESS_OWNER_LABELS,
  INSIDER_ROLE_LABELS,
  SELECTABLE_CONGRESS_OWNERS,
  SELECTABLE_INSIDER_ROLES,
  alternativeDataActorType,
  alternativeDataLookbackLabel,
  alternativeDataMeasureDefinition,
  alternativeDataScope,
  alternativeDataSupportsScope,
  strategyMetricLabel,
  type ActorGroupSummaryResponse,
  type ActorScope,
  type AlternativeDataActorResponse,
  type AlternativeDataLookback,
  type AlternativeDataMetric,
  type CongressChamberFilter,
  type CongressOwner,
  type InsiderRole,
} from "@intrinsic/contracts";
import { useEffect, useState } from "react";
import forms from "../../../components/ui/forms.module.css";
import { Modal } from "../../../components/ui/Modal";
import { Select } from "../../../components/ui/Select";
import { fetchActorGroups } from "../api/alternative-data-api";
import { ActorCombobox } from "./ActorCombobox";
import styles from "./AlternativeDataConfigDialog.module.css";

/**
 * The configuration behind one alternative-data first operand.
 *
 * `docs/alternative-data-signals.md` is explicit that this configuration belongs to the **signal**, not
 * to the condition row: the row stays `[metric] [condition] [value]`, and everything a metric can be
 * narrowed by is edited here and summarized underneath. That is why this is a dialog over the existing
 * `Modal` rather than three more controls in the row — a row with seven controls is unusable on a phone,
 * and the product's whole grammar is three.
 *
 * It edits a **draft** and commits on save, so an abandoned dialog changes nothing. The metric it
 * produces is an ordinary `StrategyMetric`, dispatched through the Builder's existing `setMetric` — the
 * same action a change of metric uses — so the operator and value are reconciled by the one canonical
 * rule rather than by anything here.
 */

export type AlternativeDataConfigDialogProps = {
  readonly metric: AlternativeDataMetric;
  readonly onClose: () => void;
  readonly onApply: (metric: AlternativeDataMetric) => void;
};

/**
 * The same metric without one optional filter key.
 *
 * Rebuilt rather than set to `undefined`, because "no filter" is the **absence** of the field: the
 * canonical document carries no key it does not mean, and a present `roles: undefined` would
 * serialize and fingerprint differently from a metric that never had one.
 */
function withoutKey<T extends object, K extends keyof T>(value: T, key: K): T {
  const rest = { ...value };
  delete rest[key];
  return rest;
}

/** A scope's three shapes, as the dialog's own radio choice. */
const SCOPE_CHOICES = [
  { kind: "ANY", label: "Anyone" },
  { kind: "ACTOR", label: "A specific one" },
  { kind: "GROUP", label: "A group" },
] as const;

export function AlternativeDataConfigDialog({
  metric,
  onClose,
  onApply,
}: AlternativeDataConfigDialogProps) {
  const [draft, setDraft] = useState<AlternativeDataMetric>(metric);
  const [groups, setGroups] = useState<readonly ActorGroupSummaryResponse[]>([]);
  const [selectedActor, setSelectedActor] = useState<
    AlternativeDataActorResponse[]
  >([]);

  const actorType = alternativeDataActorType(draft.kind);
  const scope = alternativeDataScope(draft);
  const supportsScope = alternativeDataSupportsScope(draft.kind);

  useEffect(() => {
    if (!actorType) {
      return;
    }
    const controller = new AbortController();
    fetchActorGroups({ actorType }, { signal: controller.signal })
      .then(setGroups)
      // A group list that cannot be loaded leaves the picker empty rather than breaking the dialog: the
      // rest of the configuration is still editable, and the scope keeps whatever it already had.
      .catch(() => undefined);
    return () => controller.abort();
  }, [actorType]);

  const setScope = (next: ActorScope): void => {
    setDraft((current) =>
      current.kind === "INSIDER_ACTIVITY"
        ? current
        : { ...current, scope: next },
    );
  };

  const toggle = <T extends string>(
    values: readonly T[] | undefined,
    value: T,
    order: readonly T[],
  ): readonly T[] | undefined => {
    const present = values ?? [];
    const next = present.includes(value)
      ? present.filter((entry) => entry !== value)
      : [...present, value];
    // An empty filter is "no filter", never "admit nobody": clearing the last chip is how a user says
    // "include everyone", and the canonical validator rejects an empty list for exactly that reason.
    return next.length === 0
      ? undefined
      : order.filter((entry) => next.includes(entry));
  };

  const scopeKind = scope?.kind ?? "ANY";

  return (
    <Modal
      title={`Configure ${strategyMetricLabel(draft)}`}
      onClose={onClose}
      testId="alternative-data-config"
    >
      <div className={styles.body}>
        <p className={styles.summary}>
          {alternativeDataMeasureDefinition(draft).label} counts what became
          publicly readable in the selected window — the session after a filing
          or disclosure, never the day of the trade.
        </p>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="alt-lookback">
            Lookback
          </label>
          <Select
            testId="alt-lookback"
            aria-label="Lookback"
            value={String(draft.lookback)}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                lookback: Number(value) as AlternativeDataLookback,
              }))
            }
            options={ALTERNATIVE_DATA_LOOKBACKS.map((lookback) => ({
              value: String(lookback),
              label: `${alternativeDataLookbackLabel(lookback)} — last ${lookback} trading sessions`,
            }))}
          />
        </div>

        {supportsScope && actorType ? (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Whose activity</span>
            <div className={styles.checkboxes} role="radiogroup" aria-label="Scope">
              {SCOPE_CHOICES.map((choice) => (
                <label
                  key={choice.kind}
                  className={styles.checkbox}
                  data-checked={scopeKind === choice.kind ? "true" : undefined}
                >
                  <input
                    type="radio"
                    name="alt-scope"
                    checked={scopeKind === choice.kind}
                    onChange={() =>
                      setScope(
                        choice.kind === "ANY"
                          ? { kind: "ANY" }
                          : choice.kind === "ACTOR"
                            ? {
                                kind: "ACTOR",
                                actorId: selectedActor[0]?.id ?? "",
                              }
                            : { kind: "GROUP", groupId: groups[0]?.id ?? "" },
                      )
                    }
                  />
                  {choice.label}
                </label>
              ))}
            </div>

            {scopeKind === "ACTOR" ? (
              <div className={styles.scopePicker}>
                <ActorCombobox
                  actorType={actorType}
                  mode="single"
                  selected={selectedActor}
                  onChange={(next) => {
                    setSelectedActor(next);
                    const picked = next[0];
                    if (picked) {
                      setScope({ kind: "ACTOR", actorId: picked.id });
                    }
                  }}
                  label={
                    actorType === "INSTITUTION"
                      ? "Search institutions"
                      : "Search members of Congress"
                  }
                  testId="alt-actor-picker"
                />
                <p className={styles.fieldHint}>
                  Search by name or by the identifier the filings use.
                </p>
              </div>
            ) : null}

            {scopeKind === "GROUP" ? (
              <div className={styles.scopePicker}>
                <Select
                  testId="alt-group-picker"
                  aria-label="Group"
                  value={scope?.kind === "GROUP" ? scope.groupId : ""}
                  onValueChange={(groupId) =>
                    setScope({ kind: "GROUP", groupId })
                  }
                  placeholder={
                    groups.length === 0
                      ? "No groups yet — create one in Lists"
                      : "Choose a group…"
                  }
                  placeholderDisabled
                  unavailableLabel="Unavailable group"
                  options={groups.map((group) => ({
                    value: group.id,
                    label: `${group.name} · ${group.memberCount} ${group.memberCount === 1 ? "member" : "members"}`,
                  }))}
                />
                <p className={styles.fieldHint}>
                  A backtest freezes the group&apos;s membership when it is
                  submitted, so editing the group later never changes a run that
                  already exists.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {draft.kind === "CONGRESS_ACTIVITY" ? (
          <>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Chamber</span>
              <Select
                testId="alt-chamber"
                aria-label="Chamber"
                value={draft.chamber}
                onValueChange={(value) =>
                  setDraft((current) =>
                    current.kind === "CONGRESS_ACTIVITY"
                      ? { ...current, chamber: value as CongressChamberFilter }
                      : current,
                  )
                }
                options={CONGRESS_CHAMBER_FILTERS.map((chamber) => ({
                  value: chamber,
                  label: CONGRESS_CHAMBER_FILTER_LABELS[chamber],
                }))}
              />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Disclosed owner</span>
              <div className={styles.checkboxes}>
                {SELECTABLE_CONGRESS_OWNERS.map((owner) => (
                  <label
                    key={owner}
                    className={styles.checkbox}
                    data-checked={
                      draft.kind === "CONGRESS_ACTIVITY" &&
                      draft.owners?.includes(owner)
                        ? "true"
                        : undefined
                    }
                  >
                    <input
                      type="checkbox"
                      checked={
                        draft.kind === "CONGRESS_ACTIVITY" &&
                        (draft.owners?.includes(owner) ?? false)
                      }
                      onChange={() =>
                        setDraft((current) => {
                          if (current.kind !== "CONGRESS_ACTIVITY") {
                            return current;
                          }
                          const owners = toggle<CongressOwner>(
                            current.owners,
                            owner,
                            SELECTABLE_CONGRESS_OWNERS,
                          );
                          // Rebuilt without the field, not with `owners: undefined`: an absent filter
                          // and a present-but-undefined one serialize differently, and the canonical
                          // document carries no key it does not mean.
                          return owners === undefined
                            ? withoutKey(current, "owners")
                            : { ...current, owners };
                        })
                      }
                    />
                    {CONGRESS_OWNER_LABELS[owner]}
                  </label>
                ))}
              </div>
              <p className={styles.fieldHint}>
                Leave every owner unselected to count all of them. A filing that
                names no owner is counted then, and is never selected by a
                filter — it has made no statement to filter on.
              </p>
            </div>
          </>
        ) : null}

        {draft.kind === "INSIDER_ACTIVITY" ? (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Insider role</span>
            <div className={styles.checkboxes}>
              {SELECTABLE_INSIDER_ROLES.map((role) => (
                <label
                  key={role}
                  className={styles.checkbox}
                  data-checked={
                    draft.kind === "INSIDER_ACTIVITY" &&
                    draft.roles?.includes(role)
                      ? "true"
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={
                      draft.kind === "INSIDER_ACTIVITY" &&
                      (draft.roles?.includes(role) ?? false)
                    }
                    onChange={() =>
                      setDraft((current) => {
                        if (current.kind !== "INSIDER_ACTIVITY") {
                          return current;
                        }
                        const roles = toggle<InsiderRole>(
                          current.roles,
                          role,
                          SELECTABLE_INSIDER_ROLES,
                        );
                        return roles === undefined
                          ? withoutKey(current, "roles")
                          : { ...current, roles };
                      })
                    }
                  />
                  {INSIDER_ROLE_LABELS[role]}
                </label>
              ))}
            </div>
            <p className={styles.fieldHint}>
              Leave every role unselected to count all insiders. A person is
              often more than one thing, so a filter matches when any selected
              role applies.
            </p>
          </div>
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
            type="button"
            className={forms.primaryButton}
            data-testid="alternative-data-config-apply"
            // A scope that names nothing would be rejected by the canonical validator, so it cannot be
            // applied: the button waits for a choice rather than saving something that fails.
            disabled={
              (scope?.kind === "ACTOR" && scope.actorId === "") ||
              (scope?.kind === "GROUP" && scope.groupId === "")
            }
            onClick={() => onApply(draft)}
          >
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
}
