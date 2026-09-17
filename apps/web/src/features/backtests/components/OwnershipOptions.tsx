import type { ContentOwnership } from "@intrinsic/contracts";

type OwnedOption = {
  readonly id: string;
  readonly name: string;
  readonly ownership: ContentOwnership;
};

/**
 * `<option>`s grouped into the platform's built-ins and the caller's own content.
 *
 * Built-ins are selectable wherever a plan allows a Backtest at all, so they are offered first and
 * labelled as such; the caller's own follow. With no built-ins the options render ungrouped.
 */
export function OwnershipOptions({
  items,
  ownLabel,
}: {
  readonly items: readonly OwnedOption[];
  readonly ownLabel: string;
}) {
  const builtIns = items.filter((item) => item.ownership === "SYSTEM");
  const own = items.filter((item) => item.ownership !== "SYSTEM");
  const options = (entries: readonly OwnedOption[]) =>
    entries.map((entry) => (
      <option key={entry.id} value={entry.id}>
        {entry.name}
      </option>
    ));
  if (builtIns.length === 0) {
    return <>{options(own)}</>;
  }
  return (
    <>
      <optgroup label="Built-in">{options(builtIns)}</optgroup>
      {own.length > 0 ? (
        <optgroup label={ownLabel}>{options(own)}</optgroup>
      ) : null}
    </>
  );
}
