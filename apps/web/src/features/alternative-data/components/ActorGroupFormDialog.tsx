"use client";

import {
  ACTOR_GROUP_DESCRIPTION_MAX_LENGTH,
  ACTOR_GROUP_NAME_MAX_LENGTH,
  type ActorGroupDetailResponse,
  type ActorGroupSummaryResponse,
  type AlternativeDataActorResponse,
} from "@intrinsic/contracts";
import { useState } from "react";
import forms from "../../../components/ui/forms.module.css";
import { Modal } from "../../../components/ui/Modal";
import {
  createActorGroup,
  updateActorGroup,
} from "../api/alternative-data-api";
import { ActorCombobox } from "./ActorCombobox";

/**
 * Create or rename an actor group.
 *
 * One dialog for both, like `ListFormDialog`: the fields are the same and the only difference is
 * whether members can be chosen at the same time.
 */

type ActorGroupFormDialogProps =
  | {
      readonly mode: "create";
      readonly onClose: () => void;
      readonly onCreated: (detail: ActorGroupDetailResponse) => void;
    }
  | {
      readonly mode: "rename";
      readonly group: ActorGroupSummaryResponse;
      readonly onClose: () => void;
      readonly onUpdated: (summary: ActorGroupSummaryResponse) => void;
    };

export function ActorGroupFormDialog(props: ActorGroupFormDialogProps) {
  const creating = props.mode === "create";
  const [name, setName] = useState(creating ? "" : props.group.name);
  const [description, setDescription] = useState(
    creating ? "" : (props.group.description ?? ""),
  );
  const [members, setMembers] = useState<AlternativeDataActorResponse[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("A group needs a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (props.mode === "create") {
        const detail = await createActorGroup({
          name: trimmed,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(members.length > 0
            ? { actorIds: members.map((member) => member.id) }
            : {}),
        });
        props.onCreated(detail);
        return;
      }
      const summary = await updateActorGroup(props.group.id, {
        name: trimmed,
        // An empty field clears the description rather than leaving the old one, which is what a user
        // emptying it means.
        description: description.trim() === "" ? null : description.trim(),
      });
      props.onUpdated(summary);
    } catch {
      setError("The group could not be saved. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={creating ? "New congress group" : `Rename ${props.mode === "rename" ? props.group.name : ""}`}
      onClose={props.onClose}
      testId="actor-group-form"
    >
      <div className={forms.form}>
        <div className={forms.field}>
          <label className={forms.label} htmlFor="actor-group-name">
            Name
          </label>
          <input
            id="actor-group-name"
            className={forms.input}
            data-testid="actor-group-name"
            type="text"
            value={name}
            maxLength={ACTOR_GROUP_NAME_MAX_LENGTH}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className={forms.field}>
          <label className={forms.label} htmlFor="actor-group-description">
            Description
          </label>
          <textarea
            id="actor-group-description"
            className={forms.textarea}
            data-testid="actor-group-description"
            value={description}
            maxLength={ACTOR_GROUP_DESCRIPTION_MAX_LENGTH}
            rows={2}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        {creating ? (
          <div className={forms.field}>
            <span className={forms.label}>Members</span>
            <ActorCombobox
              mode="multi"
              selected={members}
              onChange={setMembers}
              label="Search members of Congress to add"
              placeholder="Search…"
              testId="actor-group-members"
            />
            <p className={forms.hint}>
              Members can be added later too. A group is an explicit list of
              actors you chose — nothing is inferred from a committee or a
              ranking.
            </p>
          </div>
        ) : null}

        {error ? (
          <p className={forms.error} role="alert">
            {error}
          </p>
        ) : null}

        <div className={forms.actions}>
          <button
            type="button"
            className={forms.secondaryButton}
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className={forms.primaryButton}
            data-testid="actor-group-save"
            disabled={saving}
            onClick={() => void submit()}
          >
            {creating ? "Create group" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
