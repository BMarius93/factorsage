import { Notice } from "./Notice";

/**
 * Said on every built-in page an administrator can change (UI-052): a built-in is shared content,
 * so an edit here reaches every account that reads it, not only the person making it.
 */
export function BuiltInEditNotice({ thing }: { readonly thing: string }) {
  return (
    <Notice
      tone="warning"
      testId="built-in-edit-notice"
      title="Built-in content"
    >
      <p>
        You are editing a built-in {thing}. Changes apply to every account that
        reads it, as soon as you save them.
      </p>
    </Notice>
  );
}
