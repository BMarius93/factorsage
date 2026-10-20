"use client";

import { useLayoutEffect, useRef } from "react";
import forms from "../../../components/ui/forms.module.css";
import styles from "./MoneyInput.module.css";

type MoneyInputProps = {
  readonly id: string;
  readonly testId: string;
  /** The raw amount the form holds: digits and at most one decimal point, never grouping. */
  readonly value: string;
  readonly onValueChange: (raw: string) => void;
  readonly invalid: boolean;
  readonly describedBy?: string;
  readonly placeholder?: string;
};

/**
 * A US-dollar amount: `$` in front, thousands grouped as it is read and as it is typed (BT-7).
 *
 * Only the *display* is formatted. The form keeps exactly the string it kept before — `"10000"`, not
 * `"10,000"` — so validation and the submitted request are unchanged. A pasted `$12,500` arrives as
 * `12500`; anything else is kept as typed, so the ordinary validation can say what is wrong with it.
 *
 * The display is the same focused or not. An earlier version switched to raw digits on focus, and
 * that switch replaced the value under a selection made as the field was focused — Tab and a test's
 * `fill` both select everything — so the next keystroke appended to the old amount instead of
 * replacing it. Instead, every edit is regrouped and the caret is put back after the same number of
 * digits, so a separator appearing or disappearing never moves it under the user's fingers.
 */
export function MoneyInput({
  id,
  testId,
  value,
  onValueChange,
  invalid,
  describedBy,
  placeholder,
}: MoneyInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // How many characters of the raw amount preceded the caret after the last edit; consumed by the
  // layout effect once the regrouped value is on screen.
  const caretRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const digits = caretRef.current;
    caretRef.current = null;
    if (!input || digits === null || document.activeElement !== input) {
      return;
    }
    const position = displayOffset(input.value, digits);
    input.setSelectionRange(position, position);
  }, [value]);

  return (
    <span className={styles.field}>
      <span className={styles.currency} aria-hidden="true">
        $
      </span>
      <input
        ref={inputRef}
        id={id}
        className={`${forms.input} ${styles.input}`}
        data-testid={testId}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={groupThousands(value)}
        placeholder={placeholder}
        aria-invalid={invalid}
        {...(describedBy ? { "aria-describedby": describedBy } : {})}
        onChange={(event) => {
          const input = event.target;
          const next = rawAmount(input.value);
          const caret = input.selectionStart ?? input.value.length;
          const digits = rawAmount(input.value.slice(0, caret)).length;
          if (next === value) {
            // Only a separator was typed or deleted. Nothing changes in the form, so no render
            // will put the grouping back: restore it here, with the caret on the same digit.
            const shown = groupThousands(value);
            input.value = shown;
            const position = displayOffset(shown, digits);
            input.setSelectionRange(position, position);
            return;
          }
          caretRef.current = digits;
          onValueChange(next);
        }}
      />
    </span>
  );
}

/** The position in a grouped display just after its first `count` raw-amount characters. */
function displayOffset(display: string, count: number): number {
  let seen = 0;
  for (let index = 0; index < display.length; index += 1) {
    if (seen === count) {
      return index;
    }
    if (!/[\s,$]/.test(display.charAt(index))) {
      seen += 1;
    }
  }
  return display.length;
}

/** `"$12,500.5 "` → `"12500.5"`: grouping, the currency sign and spaces are display, not value. */
export function rawAmount(text: string): string {
  return text.replace(/[\s,$]/g, "");
}

/** `"12500.5"` → `"12,500.5"`; anything that is not a plain decimal amount is shown as it is. */
export function groupThousands(raw: string): string {
  const match = /^(\d+)(\.\d*)?$/.exec(raw);
  if (!match) {
    return raw;
  }
  const whole = (match[1] ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}${match[2] ?? ""}`;
}
