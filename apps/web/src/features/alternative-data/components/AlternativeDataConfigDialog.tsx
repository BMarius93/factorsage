"use client";

import {
  ACTOR_SCOPE_MAX_ACTORS,
  ALTERNATIVE_DATA_LOOKBACKS,
  CONGRESS_CHAMBER_FILTERS,
  CONGRESS_CHAMBER_FILTER_LABELS,
  CONGRESS_OWNER_LABELS,
  INSIDER_ROLE_LABELS,
  SELECTABLE_CONGRESS_OWNERS,
  SELECTABLE_INSIDER_ROLES,
  actorScopeActorIds,
  alternativeDataLookbackLabel,
  alternativeDataMeasureDefinition,
  alternativeDataScope,
  alternativeDataSupportsScope,
  canonicalActorIds,
  strategyMetricLabel,
  type ActorScope,
  type AlternativeDataLookback,
  type AlternativeDataMetric,
  type CongressChamberFilter,
  type CongressOwner,
  type InsiderRole,
} from "@intrinsic/contracts";
import { useEffect, useState } from "react";
import forms from "../../../components/ui/forms.module.css";
import { Modal } from "../../../components/ui/Modal";
import { Notice } from "../../../components/ui/Notice";
import { Select } from "../../../components/ui/Select";
import { fetchActorGroup, resolveActors } from "../api/alternative-data-api";
import { ActorCombobox, type ActorSelection } from "./ActorCombobox";
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

/**
 * Whose activity a rule counts, as the dialog's own choice: every member, or the ones selected here.
 *
 * Two choices for the two scope shapes the product writes (`SELECTABLE_ACTOR_SCOPE_KINDS`). The
 * legacy single-member and group shapes are never offered: a rule that still holds one opens on
 * "Selected members" with that member, or that group's members, already chosen.
 */
const SCOPE_CHOICES = [
  { mode: "ANY", label: "Anyone" },
  { mode: "SELECTED", label: "Selected members" },
] as const;

type ScopeMode = (typeof SCOPE_CHOICES)[number]["mode"];

/** Chips shown before the rest fold away, so a long selection does not push Apply off the dialog. */
const VISIBLE_CHIPS = 12;

/**
 * A Congress group a rule saved before 2026-10-11 still names, and what became of reading it.
 *
 * `LOADING` while its members are being fetched; `LOADED` once they are the dialog's selection;
 * `MISSING` when the group can no longer be read, which leaves the selection empty for the user to
 * fill — never silently "everyone", and never silently "nobody".
 */
type LegacyGroup =
  | { status: "LOADING" }
  | { status: "LOADED"; name: string; memberCount: number }
  | { status: "MISSING" };

function byName(left: ActorSelection, right: ActorSelection): number {
  return left.displayName < right.displayName
    ? -1
    : left.displayName > right.displayName
      ? 1
      : 0;
}

export function AlternativeDataConfigDialog({
  metric,
  onClose,
  onApply,
}: AlternativeDataConfigDialogProps) {
  const [draft, setDraft] = useState<AlternativeDataMetric>(metric);
  const savedScope = alternativeDataScope(metric);
  const supportsScope = alternativeDataSupportsScope(draft.kind);

  const [scopeMode, setScopeMode] = useState<ScopeMode>(
    savedScope === undefined || savedScope.kind === "ANY" ? "ANY" : "SELECTED",
  );
  // The members chosen in this dialog. Kept apart from the draft's scope so that switching to
  // "Anyone" and back does not throw a carefully built selection away.
  const [selected, setSelected] = useState<readonly ActorSelection[]>(() =>
    savedScope === undefined
      ? []
      : (actorScopeActorIds(savedScope) ?? []).map((id) => ({
          id,
          displayName: "Loading…",
          status: "LOADING" as const,
        })),
  );
  const [legacyGroup, setLegacyGroup] = useState<LegacyGroup | null>(
    savedScope?.kind === "GROUP" ? { status: "LOADING" } : null,
  );

  // The saved rule holds ids; the names behind them are asked for once, when the dialog opens. An id
  // the catalog does not answer for is shown as unavailable rather than dropped, because dropping it
  // would change what the rule counts without anyone having decided that.
  const savedActorIds =
    savedScope === undefined ? undefined : actorScopeActorIds(savedScope);
  const savedActorKey = savedActorIds?.join(",") ?? "";
  useEffect(() => {
    if (savedActorKey === "") {
      return;
    }
    const controller = new AbortController();
    const ids = savedActorKey.split(",");
    resolveActors(ids, { signal: controller.signal })
      .then((actors) => {
        const names = new Map(actors.map((actor) => [actor.id, actor.displayName]));
        setSelected((current) =>
          current
            .map((entry): ActorSelection => {
              if (entry.status !== "LOADING") {
                return entry;
              }
              const name = names.get(entry.id);
              return name === undefined
                ? {
                    id: entry.id,
                    displayName: "Unavailable member",
                    status: "UNAVAILABLE",
                  }
                : { id: entry.id, displayName: name };
            })
            // Alphabetical once the names are known: the saved order is by id, which means nothing
            // to a reader. Members added afterwards go in front of these.
            .sort(byName),
        );
      })
      .catch(() => {
        if (controller.signal.aborted) {
          return;
        }
        // The names could not be loaded. The selection itself is intact — it is the ids — so the
        // chips say what they are and the rule stays applicable as it was saved.
        setSelected((current) =>
          current.map((entry) =>
            entry.status === "LOADING"
              ? { id: entry.id, displayName: "Selected member" }
              : entry,
          ),
        );
      });
    return () => controller.abort();
  }, [savedActorKey]);

  // A rule that still names a group: its members become the selection, so applying the dialog
  // converts the rule without the user having to rebuild the list by hand.
  const savedGroupId = savedScope?.kind === "GROUP" ? savedScope.groupId : "";
  useEffect(() => {
    if (savedGroupId === "") {
      return;
    }
    const controller = new AbortController();
    fetchActorGroup(savedGroupId, { signal: controller.signal })
      .then((group) => {
        setSelected(
          group.members
            .map((member) => ({ id: member.id, displayName: member.displayName }))
            .sort(byName),
        );
        setLegacyGroup({
          status: "LOADED",
          name: group.name,
          memberCount: group.members.length,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLegacyGroup({ status: "MISSING" });
        }
      });
    return () => controller.abort();
  }, [savedGroupId]);

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

  const loadingGroup = legacyGroup?.status === "LOADING";
  const unavailable = selected.filter(
    (entry) => entry.status === "UNAVAILABLE",
  ).length;
  // What Apply would save. A selection is written as the canonical list of its ids; "Anyone" as
  // itself. Nothing here can produce the legacy shapes.
  const scopeToApply: ActorScope =
    scopeMode === "ANY"
      ? { kind: "ANY" }
      : {
          kind: "ACTORS",
          actorIds: canonicalActorIds(selected.map((entry) => entry.id)),
        };
  const applyBlocked =
    supportsScope &&
    scopeMode === "SELECTED" &&
    (loadingGroup || selected.length === 0 || unavailable > 0);

  return (
    <Modal
      // The metric's identity, which nothing in this dialog can change: the title names what is being
      // configured, never a lookback being edited below it.
      title={`Configure ${strategyMetricLabel(metric)}`}
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

        {supportsScope ? (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Whose activity</span>
            <div className={styles.checkboxes} role="radiogroup" aria-label="Scope">
              {SCOPE_CHOICES.map((choice) => (
                <label
                  key={choice.mode}
                  className={styles.checkbox}
                  data-checked={scopeMode === choice.mode ? "true" : undefined}
                >
                  <input
                    type="radio"
                    name="alt-scope"
                    checked={scopeMode === choice.mode}
                    onChange={() => setScopeMode(choice.mode)}
                  />
                  {choice.label}
                </label>
              ))}
            </div>

            {scopeMode === "SELECTED" ? (
              <div className={styles.scopePicker}>
                {legacyGroup?.status === "LOADED" ? (
                  <Notice tone="info" testId="alt-legacy-group">
                    This rule used the group “{legacyGroup.name}”. Groups are no
                    longer part of FactorSage, so its{" "}
                    {legacyGroup.memberCount === 1
                      ? "member is"
                      : `${legacyGroup.memberCount} members are`}{" "}
                    selected below. Apply to keep{" "}
                    {legacyGroup.memberCount === 1 ? "that member" : "them"}.
                  </Notice>
                ) : null}
                {legacyGroup?.status === "MISSING" ? (
                  <Notice tone="warning" testId="alt-legacy-group">
                    This rule used a group that is no longer available. Choose
                    the members it should count.
                  </Notice>
                ) : null}
                {loadingGroup ? (
                  <p className={styles.fieldHint} role="status">
                    Loading the members this rule counts…
                  </p>
                ) : (
                  <ActorCombobox
                    selected={selected}
                    onChange={setSelected}
                    maxSelected={ACTOR_SCOPE_MAX_ACTORS}
                    collapseAfter={VISIBLE_CHIPS}
                    label="Search members of Congress"
                    placeholder={
                      selected.length === 0
                        ? "Search by name…"
                        : "Add another member…"
                    }
                    emptyHint="Only members with disclosures FactorSage has already loaded can be found. Try the surname alone."
                    testId="alt-actor-picker"
                  />
                )}
                {unavailable > 0 ? (
                  <p
                    className={styles.fieldError}
                    role="alert"
                    data-testid="alt-actor-unavailable"
                  >
                    {unavailable === 1
                      ? "1 selected member is no longer available. Remove it to apply."
                      : `${unavailable} selected members are no longer available. Remove them to apply.`}
                  </p>
                ) : null}
                <p className={styles.fieldHint} data-testid="alt-actor-count">
                  {selected.length === 0
                    ? "Select at least one member."
                    : `${selected.length} of ${ACTOR_SCOPE_MAX_ACTORS} selected.`}{" "}
                  Their disclosures are counted together as one total, not as
                  separate rules. The list holds the members who appear in the
                  disclosures FactorSage has loaded so far, so it is not every
                  member of Congress.
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
            // A selection of nobody would be rejected by the canonical validator, and one holding a
            // member the catalog no longer has by the API, so neither can be applied: the button
            // waits for the selection to be fixed rather than saving something that fails.
            disabled={applyBlocked}
            onClick={() =>
              onApply(
                draft.kind === "CONGRESS_ACTIVITY"
                  ? { ...draft, scope: scopeToApply }
                  : draft,
              )
            }
          >
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
}
