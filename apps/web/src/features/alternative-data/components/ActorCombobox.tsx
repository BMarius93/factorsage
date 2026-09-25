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
 * A searchable combobox over the canonical actor catalog.
 *
 * `docs/alternative-data-signals.md` asks for this rather than a giant native select, and the reason is
 * the data: the catalog runs to hundreds of members of Congress, so an `<option>` list is unwieldy on
 * any device and unbearable on a phone. It is the same interaction the stock pickers already use —
 * type, arrow, Enter — and it only ever yields a real catalog row: free text is never turned into a
 * selection.
 *
 * `mode` decides what picking means. `single` replaces the selection, which is what a "specific actor"
 * scope needs; `multi` toggles, which is what building a group's membership needs.
 */

const SEARCH_DEBOUNCE_MS = 200;

export type ActorComboboxProps = {
  readonly mode: "single" | "multi";
  readonly selected: readonly AlternativeDataActorResponse[];
  readonly onChange: (next: AlternativeDataActorResponse[]) => void;
  readonly label: string;
  readonly placeholder?: string;
  /** Ids already in the group. Shown, annotated, and never picked again. */
  readonly excludedIds?: ReadonlySet<string>;
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
  mode,
  selected,
  onChange,
  label,
  placeholder,
  excludedIds,
  testId,
}: ActorComboboxProps) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<readonly AlternativeDataActorResponse[]>(
    [],
  );
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [active, setActive] = useState(0);
  const latestRequestRef = useRef(0);
  const selectedIds = new Set(selected.map((actor) => actor.id));

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
      if (excludedIds?.has(actor.id)) {
        return;
      }
      if (mode === "single") {
        onChange([actor]);
        setOpen(false);
        setTerm("");
        return;
      }
      onChange(
        selectedIds.has(actor.id)
          ? selected.filter((entry) => entry.id !== actor.id)
          : [...selected, actor],
      );
      setTerm("");
      inputRef.current?.focus();
    },
    [excludedIds, mode, onChange, selected, selectedIds],
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
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (
      event.key === "Backspace" &&
      term === "" &&
      mode === "multi" &&
      selected.length > 0
    ) {
      onChange(selected.slice(0, -1));
    }
  };

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
        {mode === "multi"
          ? selected.map((actor) => (
              <span key={actor.id} className={styles.chip}>
                {actor.displayName}
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={`Remove ${actor.displayName}`}
                  onClick={() =>
                    onChange(selected.filter((entry) => entry.id !== actor.id))
                  }
                >
                  ×
                </button>
              </span>
            ))
          : null}
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
          placeholder={
            mode === "single" && selected[0]
              ? selected[0].displayName
              : (placeholder ?? "Search…")
          }
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
          {status === "error" ? (
            <li className={styles.empty}>Search is unavailable right now.</li>
          ) : options.length === 0 ? (
            <li className={styles.empty}>
              {status === "loading" ? "Searching…" : "No matches."}
            </li>
          ) : (
            options.map((actor, index) => (
              <li
                key={actor.id}
                role="option"
                aria-selected={selectedIds.has(actor.id)}
                className={styles.option}
                data-active={index === active ? "true" : undefined}
                data-selected={selectedIds.has(actor.id) ? "true" : undefined}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  // Before blur, so the field does not close under the pointer.
                  event.preventDefault();
                  pick(actor);
                }}
              >
                <span className={styles.name}>{actor.displayName}</span>
                <span className={styles.meta}>
                  {excludedIds?.has(actor.id)
                    ? "In group"
                    : actorMetaLabel(actor)}
                </span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
