# GitHub Copilot repository instructions

Keep agent work narrow, terse, and evidence-driven.

- Follow `AGENTS.md`. Read additional files under `ai/` only when they are relevant to the current task; do not load the entire documentation tree by default.
- Stay strictly within the requested scope. Do not refactor, clean up, or redesign unrelated code.
- Do not repeat the task or narrate routine tool calls. Report only meaningful findings, failures, changes, and validation results.
- Search and read narrowly. Prefer targeted symbols/files, and do not reread unchanged files unless new evidence requires it.
- Prefer existing tests and logs over ad-hoc reproduction scripts. Create temporary probes only when existing evidence cannot identify the failure, and never commit them.
- During implementation, run the smallest relevant test/typecheck command after a change. Run the full repository validation gate once after the implementation is settled.
- Do not dump successful command output. For failures, surface the relevant error and enough surrounding context to diagnose it.
- When the task is explicitly review/validate/commit/push only, do not modify implementation. If validation fails, stop and report the failure unless the user explicitly asked you to fix it.
- When asked to investigate before fixing, identify and explain the root cause before changing code. Once the root cause is confirmed, stop exploring unrelated alternatives.
- Preserve existing architecture and public contracts unless the task explicitly requires changing them.
- Keep final reports concise: files changed, reason, validation, runtime evidence when relevant, and remaining risk only.
