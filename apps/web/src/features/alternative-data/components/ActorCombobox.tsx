"use client";

import {
  ACTOR_SEARCH_DEFAULT_LIMIT,
  type AlternativeDataActorResponse,
} from "@intrinsic/contracts";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { searchActors } from "../api/alternative-data-api";
import styles from "./ActorCombobox.module.css";

/**
 * A searchable multi-select over the canonical actor catalog: members of Congress.
 *
 * `docs/alternative-data-signals.md` asks for this rather than a giant native select, and the reason
 * is the data: the catalog runs to hundreds of members, so an `<option>` list is unwieldy on any
 * device and unbearable on a phone. It is the same interaction the stock pickers already use — type,
 * arrow, Enter — and it only ever yields a real catalog row: free text is never turned into a
 * selection.
 *
 * The selection is shown as removable chips, in the order the caller gives them, and stays put while
 * the search changes: what is chosen and what is being looked for are different things. Picking a
 * member who is already chosen removes them, so nobody can be selected twice.
 */

const SEARCH_DEBOUNCE_MS = 200;

/**
 * One chosen member, as a chip shows it.
 *
 * A subset of the catalog row on purpose: a chip needs the identity and a label, and a saved rule
 * knows its ids before it knows anything else about them. `status` covers the two states a saved id
 * can be in besides "resolved" — its name is still in flight, or the catalog no longer holds it.
 */
export type ActorSelection = {
  readonly id: string;
  readonly displayName: string;
  readonly status?: "LOADING" | "UNAVAILABLE";
};

export type ActorComboboxProps = {
  readonly selected: readonly ActorSelection[];
  readonly onChange: (next: ActorSelection[]) => void;
  readonly label: string;
  readonly placeholder?: string;
  /** The most members that may be chosen. Reaching it stops further picks; removing still works. */
  readonly maxSelected?: number;
  /**
   * How many chips are shown before the rest fold into a "+N more" control.
   *
   * A selection can run to hundreds of members, and a field that tall pushes everything else out of
   * the dialog. Folding keeps the dialog one scrolling surface instead of nesting a second one
   * inside it; the caller orders `selected` so the chips worth seeing come first.
   */
  readonly collapseAfter?: number;
  /** Said under "No matches.", for a caller that knows why a search might legitimately be empty. */
  readonly emptyHint?: string;
  readonly testId?: string;
};

/** How an actor reads in a list row: the seat behind the name. */
export function actorMetaLabel(actor: AlternativeDataActorResponse): string {
  return [
    actor.chamber === "SENATE" ? "Senate" : "House",
    actor.district ?? actor.state ?? null,
  ]
    .filter((part) => part)
    .join(" · ");
}

export function ActorCombobox({
  selected,
  onChange,
  label,
  placeholder,
  maxSelected,
  collapseAfter,
  emptyHint,
  testId,
}: ActorComboboxProps) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [options, setOptions] = useState<readonly AlternativeDataActorResponse[]>(
    [],
  );
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [active, setActive] = useState(0);
  const latestRequestRef = useRef(0);
  const selectedIds = new Set(selected.map((actor) => actor.id));
  const full = maxSelected !== undefined && selected.length >= maxSelected;

  // Debounced, and aborted on every keystroke: the catalog search runs on a shared rate-limit policy
  // with the stock search, so a per-keystroke request would spend an allowance the product needs.
  useEffect(() => {
    if (!open) {
      return;
    }
    const requestId = ++latestRequestRef.current;
    const controller = new AbortController();
    setStatus("loading");
    const timer = setTimeout(() => {
      searchActors(
        {
          ...(term.trim() ? { term: term.trim() } : {}),
          limit: ACTOR_SEARCH_DEFAULT_LIMIT,
        },
        { signal: controller.signal },
      )
        .then((result) => {
          if (requestId !== latestRequestRef.current) {
            return;
          }
          setOptions(result);
          setActive(0);
          setStatus("idle");
        })
        .catch(() => {
          if (
            requestId !== latestRequestRef.current ||
            controller.signal.aborted
          ) {
            return;
          }
          setStatus("error");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, term]);

  // A click outside closes the list. Pointer-down rather than click, so it fires before a button
  // inside the surrounding dialog receives its own click.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const pick = useCallback(
    (actor: AlternativeDataActorResponse) => {
      if (selectedIds.has(actor.id)) {
        onChange(selected.filter((entry) => entry.id !== actor.id));
      } else if (full) {
        // The bound is the validator's; a pick past it would only be refused on save.
        return;
      } else {
        // Newest first, so a member just added is visible even while the chips are folded.
        onChange([
          { id: actor.id, displayName: actor.displayName },
          ...selected,
        ]);
      }
      setTerm("");
      inputRef.current?.focus();
    },
    [full, onChange, selected, selectedIds],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.min(current + 1, options.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const option = options[active];
      if (open && option) {
        // Enter picks the highlighted row. Free text is never turned into a selection: only a real
        // catalog row can ever be chosen.
        event.preventDefault();
        pick(option);
      }
      return;
    }
    if (event.key === "Escape" && open) {
      // Closes the list only. Stopped here so the surrounding dialog does not take the same key as
      // "discard everything".
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  const folded =
    collapseAfter !== undefined && !expanded && selected.length > collapseAfter;
  const chips = folded ? selected.slice(0, collapseAfter) : selected;
  const hidden = selected.length - chips.length;

  return (
    <div
      className={styles.combobox}
      ref={containerRef}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <div
        className={styles.field}
        onClick={() => inputRef.current?.focus()}
      >
        {chips.map((actor) => (
          <span
            key={actor.id}
            className={styles.chip}
            data-status={actor.status}
            data-testid="actor-chip"
          >
            {actor.displayName}
            <button
              type="button"
              className={styles.chipRemove}
              aria-label={`Remove ${actor.displayName}`}
              onClick={(event) => {
                // The field focuses the input on click; a removal should not also open the list.
                event.stopPropagation();
                onChange(selected.filter((entry) => entry.id !== actor.id));
              }}
            >
              ×
            </button>
          </span>
        ))}
        {hidden > 0 ? (
          <button
            type="button"
            className={styles.fold}
            data-testid="actor-chips-expand"
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(true);
            }}
          >
            +{hidden} more
          </button>
        ) : null}
        {collapseAfter !== undefined &&
        expanded &&
        selected.length > collapseAfter ? (
          <button
            type="button"
            className={styles.fold}
            data-testid="actor-chips-collapse"
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(false);
            }}
          >
            Show fewer
          </button>
        ) : null}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          className={styles.input}
          aria-label={label}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          autoComplete="off"
          value={term}
          placeholder={placeholder ?? "Search…"}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </div>

      {open ? (
        <ul className={styles.listbox} id={listboxId} role="listbox">
          {full ? (
            <li className={styles.notice} role="presentation">
              You have selected the maximum of {maxSelected}. Remove one to
              add another.
            </li>
          ) : null}
          {status === "error" ? (
            <li className={styles.empty}>Search is unavailable right now.</li>
          ) : options.length === 0 ? (
            <li className={styles.empty}>
              {status === "loading" ? "Searching…" : "No matches."}
              {status !== "loading" && emptyHint ? (
                <span className={styles.emptyHint}>{emptyHint}</span>
              ) : null}
            </li>
          ) : (
            options.map((actor, index) => {
              const chosen = selectedIds.has(actor.id);
              return (
                <li
                  key={actor.id}
                  role="option"
                  aria-selected={chosen}
                  aria-disabled={full && !chosen ? true : undefined}
                  className={styles.option}
                  data-active={index === active ? "true" : undefined}
                  data-selected={chosen ? "true" : undefined}
                  data-disabled={full && !chosen ? "true" : undefined}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => {
                    // Before blur, so the field does not close under the pointer.
                    event.preventDefault();
                    pick(actor);
                  }}
                >
                  <span className={styles.name}>{actor.displayName}</span>
                  <span className={styles.meta}>{actorMetaLabel(actor)}</span>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
