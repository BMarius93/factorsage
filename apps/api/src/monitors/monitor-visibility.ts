import {
  isAdministrator,
  type ContentViewer,
} from "../builtins/content-access";

/**
 * The Monitors a viewer can see: their own, published built-ins, and — for an administrator —
 * every built-in.
 */
export function visibleMonitorWhere(viewer: ContentViewer) {
  const builtIns = isAdministrator(viewer)
    ? { ownership: "SYSTEM" as const }
    : { ownership: "SYSTEM" as const, isPublished: true };
  return viewer ? { OR: [{ userId: viewer.id }, builtIns] } : builtIns;
}
