"use client";

import type { ContentOwnership } from "@intrinsic/contracts";
import { Select, type SelectOptionGroup } from "./Select";

export type EntitySelectItem = {
  readonly id: string;
  readonly name: string;
  readonly ownership: ContentOwnership;
};

export type EntitySelectKind = "strategy" | "list";

const COPY: Record<
  EntitySelectKind,
  {
    readonly placeholder: string;
    readonly loading: string;
    readonly own: string;
    readonly builtIn: string;
    readonly unavailable: string;
  }
> = {
  strategy: {
    placeholder: "Select a strategy…",
    loading: "Loading strategies…",
    own: "Your strategies",
    builtIn: "Built-in strategies",
    unavailable: "Unavailable strategy (deleted or not yours)",
  },
  list: {
    placeholder: "Select a stock list…",
    loading: "Loading stock lists…",
    own: "Your lists",
    builtIn: "Built-in lists",
    unavailable: "Unavailable stock list (deleted or not yours)",
  },
};

type EntitySelectProps = {
  readonly id: string;
  readonly kind: EntitySelectKind;
  readonly items: readonly EntitySelectItem[];
  readonly value: string;
  readonly onValueChange: (id: string) => void;
  /** The options are still loading: the control is disabled and says so in place. */
  readonly loading?: boolean;
  readonly invalid?: boolean;
  readonly describedBy?: string;
  readonly testId?: string;
};

/**
 * Choosing a Strategy or a Stock List, the same way everywhere.
 *
 * One ownership rule: the caller's own content first, then the built-ins, in two groups named like
 * the collection pages' two sections. A surface that cannot use built-ins (a user's monitor) passes
 * only the caller's own items and says why next to the control; the picker never pretends the
 * built-ins do not exist. An id that is no longer among the items stays visible as "Unavailable"
 * rather than silently rendering the placeholder while state still holds it.
 */
export function EntitySelect({
  id,
  kind,
  items,
  value,
  onValueChange,
  loading = false,
  invalid = false,
  describedBy,
  testId,
}: EntitySelectProps) {
  const copy = COPY[kind];
  const toOptions = (entries: readonly EntitySelectItem[]) =>
    entries.map((entry) => ({ value: entry.id, label: entry.name }));
  const own = items.filter((item) => item.ownership !== "SYSTEM");
  const builtIns = items.filter((item) => item.ownership === "SYSTEM");
  // Ungrouped when there is only one kind of content: a lone group heading adds nothing.
  const grouped = own.length > 0 && builtIns.length > 0;
  const groups: SelectOptionGroup[] = grouped
    ? [
        { label: copy.own, options: toOptions(own) },
        { label: copy.builtIn, options: toOptions(builtIns) },
      ]
    : [];

  return (
    <Select
      id={id}
      value={loading ? "" : value}
      onValueChange={onValueChange}
      placeholder={loading ? copy.loading : copy.placeholder}
      options={grouped ? [] : toOptions(items)}
      groups={groups}
      unavailableLabel={copy.unavailable}
      disabled={loading}
      invalid={invalid}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
      {...(testId ? { testId } : {})}
    />
  );
}
