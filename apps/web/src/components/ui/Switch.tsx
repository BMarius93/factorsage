"use client";

import styles from "./Switch.module.css";

type SwitchProps = {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  /** Accessible name; the switch has no visible text of its own. */
  readonly label: string;
  readonly disabled?: boolean;
  /** Shown while a change is being saved. */
  readonly pending?: boolean;
  readonly testId?: string;
};

/**
 * An on/off control for a setting that applies immediately.
 *
 * A native `button` with `role="switch"`, so keyboard and assistive technology get the real
 * semantics. The owner decides what a change does — including refusing it, as a Guest's toggle
 * does by asking to sign in.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  pending,
  testId,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={pending || undefined}
      className={styles.switch}
      data-checked={checked ? "true" : "false"}
      disabled={disabled || pending}
      onClick={() => onChange(!checked)}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <span className={styles.thumb} aria-hidden="true" />
    </button>
  );
}
