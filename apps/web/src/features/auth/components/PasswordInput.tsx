"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import styles from "./auth-form.module.css";

type PasswordInputProps = Omit<
  ComponentPropsWithoutRef<"input">,
  "type" | "className"
> & {
  /** Required: the field's `<label htmlFor>` and the toggle's `aria-controls` both point at it. */
  readonly id: string;
};

/** What the toggle's polite status says after it is pressed. */
export const PASSWORD_SHOWN_STATUS = "Your password is visible.";
export const PASSWORD_HIDDEN_STATUS = "Your password is hidden.";

/**
 * A password field with a Show/Hide control (AU-1), used by every password field in the product:
 * sign-in, choosing a password on activation, and resetting one.
 *
 * - **The control is a real button**, `type="button"`, so pressing it — by pointer, Enter or
 *   Space — never submits the form. Its accessible name is the action it would take, "Show
 *   password" or "Hide password", and it names the field it controls with `aria-controls`.
 * - **The state is said once, not twice.** The name changes with the state, so the button carries
 *   no `aria-pressed` as well: "Hide password, pressed" reads as the opposite of what is true. A
 *   visually hidden polite status says "Your password is visible/hidden" instead, because a
 *   screen reader does not reliably re-read the name of the button it is on.
 * - **The name is one hidden phrase, not `aria-label`.** A sighted user reads "Show"; assistive
 *   technology reads the visually hidden "Show password" — one text node, so no browser can run
 *   the two words together — which contains the visible word (WCAG 2.5.3). Without an
 *   `aria-label` the button is never matched as a second field labelled "Password".
 * - **Typing is not interrupted.** A pointer press does not take focus from the field, and the
 *   caret and selection survive the type switch. The value, `name`, `autoComplete` and every
 *   other attribute pass straight through to the one `<input>`, so a password manager sees the
 *   same field it always did.
 * - **Submitting hides it again**, before the request goes out: a password manager recognises the
 *   credential by its `type="password"` field, and a shown password should not stay on screen
 *   once the person has moved on.
 *
 * Visibility is local to this field and resets with it; it is never remembered.
 */
export function PasswordInput({
  id,
  disabled,
  ...inputProps
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // The field's selection at the moment the toggle was pressed, put back once the type changed.
  const selection = useRef<readonly [number, number] | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const range = selection.current;
    selection.current = null;
    // Only for the focused field: setting a selection on an unfocused input can focus it in some
    // browsers, and the keyboard user who pressed the button expects to stay on the button.
    if (input && range && document.activeElement === input) {
      input.setSelectionRange(range[0], range[1]);
    }
  }, [visible]);

  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) {
      return undefined;
    }
    const hide = () => {
      setVisible(false);
      setStatus("");
    };
    form.addEventListener("submit", hide);
    return () => form.removeEventListener("submit", hide);
  }, []);

  function toggle() {
    const input = inputRef.current;
    if (input && input.selectionStart !== null && input.selectionEnd !== null) {
      selection.current = [input.selectionStart, input.selectionEnd];
    }
    const next = !visible;
    setVisible(next);
    setStatus(next ? PASSWORD_SHOWN_STATUS : PASSWORD_HIDDEN_STATUS);
  }

  return (
    <div className={styles.passwordField}>
      <input
        {...inputProps}
        ref={inputRef}
        id={id}
        className={styles.passwordInput}
        type={visible ? "text" : "password"}
        disabled={disabled}
      />
      <button
        type="button"
        className={styles.passwordToggle}
        aria-controls={id}
        onClick={toggle}
        // Keeps focus — and the caret — in the field for a pointer press. A keyboard press never
        // sends a mousedown, so a keyboard user stays on the button.
        onMouseDown={(event) => event.preventDefault()}
        disabled={disabled}
        data-testid={`${id}-visibility`}
      >
        <span aria-hidden="true">{visible ? "Hide" : "Show"}</span>
        <span className={styles.visuallyHidden}>
          {visible ? "Hide password" : "Show password"}
        </span>
      </button>
      <span className={styles.visuallyHidden} aria-live="polite">
        {status}
      </span>
    </div>
  );
}
