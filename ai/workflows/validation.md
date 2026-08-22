# Validation

Default completion gate:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Do not suppress failing type checks.

For a migrated financial behavior:
1. port the old test or create an equivalent characterization test,
2. verify old expected behavior,
3. only then refactor the implementation.

For a vertical slice:
1. unit tests,
2. integration tests,
3. Playwright user journey once the UI/API path exists.
