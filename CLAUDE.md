# Claude Code repository instructions

Use `AGENTS.md` as the repository-wide source of truth for product invariants, architecture boundaries, code-change rules, observability, agent efficiency, and validation.

- Read `AGENTS.md` before making substantive changes.
- Read `ai/README.md` before substantial work, then load only the files under `ai/` that are relevant to the current task.
- Keep investigation and implementation narrowly scoped to the user's request; do not perform unrelated refactors or cleanup.
- Prefer targeted searches, existing tests, and existing logs over broad repository scans or ad-hoc diagnostics.
- Follow the validation workflow defined in `AGENTS.md`; during iteration use the smallest relevant checks, then run the full gate once the implementation is settled.
- Do not duplicate or reinterpret architecture and product rules in this file. Update the shared source of truth in `AGENTS.md` or the relevant `ai/` document when those rules change.
