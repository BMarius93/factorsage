# Strategy Builder — Implementation Plan (Create/Edit Strategy)

## Status

Plan only. Nothing here is implemented. `apps/web/src/app/(app)/strategies/page.tsx` is still a
`RoutePlaceholder`, and no Strategy type, contract, schema or endpoint exists.

All Builder product questions are closed (§ 15); the registry is ready to be frozen in Phase A.

Scope is the **Create/Edit Strategy vertical slice**: defining reusable BUY / SELL / FINAL EXIT
logic, validating it, saving it and editing it again. `ai/product/strategies.md` is the
authoritative product definition; this document does not restate or alter it.

**Explicitly out of scope**: the backtest day loop, worker queue, execution-price model,
contribution processing, candidate ordering and the portfolio simulator. Those are designed in
`strategy-evaluation.md`, which stays as written — its Phase 1–4 findings and its thirteen open
questions remain the record for that work. Only the small number of those questions that change
*what a user can define* are pulled forward here; § 12 lists which, and why the rest stay deferred.

A useful property of this slice: **it needs no market data**. The operand catalog is static in
`@intrinsic/contracts`, so nothing in the Builder touches FMP, Redis, the stock loader or the
derived state. Its tests are fast and deterministic, and no QA stock seeding is required.

---

## 1. Package placement

| Concern | Package | Why |
| --- | --- | --- |
| Strategy types, compatibility registry, validation, normalization, human-readable rendering, help text | `@intrinsic/contracts` | `apps/web` may depend on nothing else, and `AGENTS.md` invariant 11 requires Strategy Builder and backend validation to share **one** compatibility definition |
| Persistence, ownership, versioning, HTTP | `apps/api` (`src/strategies/`) | mirrors the `lists` slice exactly |
| Builder UI | `apps/web` (`src/features/strategies/`) | the established feature layout |

**The Builder slice introduces no new package.** `strategy-evaluation.md` § 2.1 proposes a pure
`@intrinsic/strategy` for the *evaluator*; nothing in Create/Edit needs it, so it is deferred to
the backtest slice and no `AGENTS.md` dependency-rule change is required now.

Putting validation in `@intrinsic/contracts` follows existing practice rather than stretching it:
that package already carries behaviour — `findSelectableSeries`, `comparableMovingAverages`,
`SELECTABLE_SERIES_GROUPED`, `DEFAULT_SELECTED_SERIES_IDS` — for exactly the same reason.

---

## 2. Canonical Strategy domain types

New file `packages/contracts/src/strategies.ts`, re-exported from `src/index.ts`.

```ts
export const STRATEGY_LEVEL_KINDS = ["BUY", "SELL", "FINAL_EXIT"] as const;
export type StrategyLevelKind = (typeof STRATEGY_LEVEL_KINDS)[number];

export const BUY_LEVEL_PERCENTAGES  = [25, 50, 75, 100] as const;
export const SELL_LEVEL_PERCENTAGES = [25, 50, 75] as const;

export type StrategyMetric =
  | { kind: "PRICE" }
  | { kind: "MOVING_AVERAGE"; seriesId: SelectableSeriesId }    // any of the 14 catalog averages
  | { kind: "OSCILLATOR"; seriesId: SelectableSeriesId }        // RSI_7D | RSI_14D | RSI_21D
  | { kind: "MARGIN_OF_SAFETY"; sourceId: SelectableSeriesId }  // one of the 7 intrinsic entries
  | { kind: "GAIN" }
  | { kind: "LOSS" };

export type StrategyValue =
  | { kind: "SERIES"; seriesId: SelectableSeriesId }
  | { kind: "NUMBER"; value: number }
  | { kind: "PERCENT"; value: number };

export type ConditionOperator = "IS_ABOVE" | "IS_BELOW" | "IS_CLOSE_TO";
export type TriggerOperator   = "CROSSES_ABOVE" | "CROSSES_BELOW";

export type StrategyCondition = {
  id: string;
  metric: StrategyMetric;
  operator: ConditionOperator;
  value: StrategyValue;
};

export type StrategyTrigger = {
  id: string;
  metric: StrategyMetric;
  operator: TriggerOperator;
  value: StrategyValue;
};

/** At most one Trigger is structural: a single optional field, not a runtime rule. */
export type StrategySignal = {
  conditions: StrategyCondition[];
  trigger?: StrategyTrigger;
};

export type StrategyBuyLevel  = { id: string; signal: StrategySignal; percentage: 25|50|75|100 };
export type StrategySellLevel = { id: string; signal: StrategySignal; percentage: 25|50|75 };
/** FINAL EXIT has no percentage field at all — the type makes the rule unrepresentable. */
export type StrategyFinalExit = { id: string; signal: StrategySignal };

export type StrategyDefinition = {
  schemaVersion: 1;
  buyLevels: StrategyBuyLevel[];
  sellLevels: StrategySellLevel[];
  finalExit?: StrategyFinalExit;
};
```

Three product rules are enforced by the **type**, not by a runtime check, and their validation
tests assert the absence of a field rather than a rejection path:

- at most one Trigger per Signal (`trigger?:` is singular);
- FINAL EXIT carries no percentage;
- no Strategy-owned Stock List, capital, contribution, `maximumPositions` or date range.

`Price` is deliberately not a catalog entry, so it is its own metric kind. Moving averages and RSI
are addressed through their **catalog ids**, never a parallel enum. `Margin of Safety` is a first-class metric parameterized
by a catalog intrinsic source — never a comparison operator.

Ids on levels, conditions and the trigger are client-generated, stable and persisted, so future
per-level diagnostics can reference them. They are stripped before hashing (§ 5), so re-keying a
row never creates a new version while genuine reordering still does.

---

## 3. One shared Metric / operator / Value compatibility registry

Same file. This is the single object `AGENTS.md` invariant 11 demands; the API validator and every
Builder select read it, and neither keeps its own list.

```ts
export type StrategyValueSpec =
  /** A fixed id set, or one derived from the metric's own series — see `valueSpecFor`. */
  | { kind: "SERIES"; seriesIds: readonly SelectableSeriesId[] }
  | { kind: "NUMBER"; min: number; max: number; step: number }
  /** Open-ended bounds: `min`/`max` are omitted where the metric has no bound on that side. */
  | { kind: "PERCENT"; min?: number; max?: number };

export type StrategyMetricDefinition = {
  kind: StrategyMetric["kind"];
  /** Catalog-backed metrics carry no label here; theirs comes from the catalog. */
  label?: string;
  group: "PRICE" | "OSCILLATORS" | "VALUATION" | "POSITION";
  /** Catalog ids this metric may be instantiated with (moving averages, RSI periods, MOS sources). */
  parameterSeriesIds?: readonly SelectableSeriesId[];
  /**
   * Set when the permitted Values depend on which series the metric was instantiated with, rather
   * than being a fixed list. `COMPARABLE_MOVING_AVERAGES` resolves through
   * `comparableMovingAverages(seriesId)` — same timeframe, never itself.
   */
  valueSource?: "COMPARABLE_MOVING_AVERAGES";
  conditionOperators: readonly ConditionOperator[];
  triggerOperators: readonly TriggerOperator[];
  value: StrategyValueSpec;
  allowedIn: readonly StrategyLevelKind[];
};
```

V1 registry content, transcribed from `ai/product/strategies.md`'s compatibility table — no
inference, no additions:

| Metric | Conditions | Triggers | Value | Allowed in |
| --- | --- | --- | --- | --- |
| `PRICE` | `IS_ABOVE`, `IS_BELOW`, `IS_CLOSE_TO` | `CROSSES_ABOVE`, `CROSSES_BELOW` | `SERIES`, the 21 price-scaled catalog entries (14 moving averages + 7 intrinsic) | BUY, SELL, FINAL_EXIT |
| `MOVING_AVERAGE` (14 catalog averages) | `IS_ABOVE`, `IS_BELOW`, `IS_CLOSE_TO` | `CROSSES_ABOVE`, `CROSSES_BELOW` | `SERIES` resolved per instance through `comparableMovingAverages(seriesId)` | BUY, SELL, FINAL_EXIT |
| `OSCILLATOR` (RSI 7D/14D/21D) | `IS_ABOVE`, `IS_BELOW` | `CROSSES_ABOVE`, `CROSSES_BELOW` | `NUMBER` 1…100 step 1 | BUY, SELL, FINAL_EXIT |
| `MARGIN_OF_SAFETY` (7 intrinsic sources) | `IS_ABOVE`, `IS_BELOW` | `CROSSES_ABOVE`, `CROSSES_BELOW` | `PERCENT` `<= 100` | BUY, SELL, FINAL_EXIT |
| `GAIN` | `IS_ABOVE`, `IS_BELOW` | `CROSSES_ABOVE`, `CROSSES_BELOW` | `PERCENT` `>= -100` | SELL, FINAL_EXIT |
| `LOSS` | `IS_ABOVE`, `IS_BELOW` | `CROSSES_ABOVE`, `CROSSES_BELOW` | `PERCENT` `0 … 100` | SELL, FINAL_EXIT |

The price-scaled Value set is **derived**, not listed:
`SELECTABLE_SERIES_CATALOG.filter(e => e.source.kind !== "OSCILLATOR")` — an oscillator is unitless
and is never comparable with Price, which is exactly what
`docs/decisions/selectable-series-catalog.md` § Consumer filtering already says. Add it beside
`MOVING_AVERAGE_SERIES` and `INTRINSIC_VALUE_SERIES` as `PRICE_COMPARABLE_SERIES`.

**Moving-average Values are resolved per instance, not listed.** `valueSpecFor` calls
`comparableMovingAverages(metric.seriesId)`, which already encodes both rules — same timeframe, and
never the series itself — so no daily-versus-weekly pair can appear and no numeric similarity is
ever inferred. This is the single source of that compatibility; neither the API validator nor the
Builder restates it.

**Percentage domains are metric-specific, not one shared range.** Each is the metric's own
semantics, which is why a single arbitrary range would be wrong:

| Metric | Domain | Why that bound |
| --- | --- | --- |
| `MARGIN_OF_SAFETY` | any finite percentage `<= 100`, no lower bound | with a positive price and a positive intrinsic value, MOS is always below 100; below zero it just means price exceeds intrinsic value, which is a legitimate rule |
| `GAIN` | any finite percentage `>= -100`, no upper bound | signed; a long position cannot lose more than its whole cost, and upside is unbounded |
| `LOSS` | `0 … 100` | non-negative and clamped at zero by definition, and a long position cannot lose more than 100% |

Decimal thresholds are allowed on all three (`22.5`, `-10`, `7.25`); there is no step constraint.
Normalization only requires a finite number, so `22.50` and `22.5` are the same value and the
definition hash is stable. The Builder's numeric input rounds its display to two decimals as a
presentation choice — a technical decision, not a product bound.

### Exported functions

```ts
strategyMetricOptions(levelKind): readonly StrategyMetricOption[]  // grouped, ordered
conditionOperatorsFor(metric): readonly ConditionOperator[]
triggerOperatorsFor(metric): readonly TriggerOperator[]
valueSpecFor(metric, operator): StrategyValueSpec   // resolves per-instance series sets
defaultValueFor(metric, operator): StrategyValue

strategyMetricLabel(metric): string
strategyValueLabel(value): string
conditionOperatorLabel(op): string   // "is above" | "is below" | "is close to"
triggerOperatorLabel(op): string     // "crosses above" | "crosses below"
```

**Label rule.** For every catalog-backed identity the label is `findSelectableSeries(id).label` and
nothing else. `Margin of Safety (DCF (FCFF))` reads poorly, so `strategyMetricLabel` composes
`Margin of Safety (<catalog label>)` in **one** function — a composition, not a second label map.
A parity test (§ 11) asserts this, which is what keeps invariant 9 true.

**Ordering.** Metric options are grouped
`PRICE → MOVING_AVERAGES → OSCILLATORS → VALUATION → POSITION`, and inside the catalog-backed
groups the order is the catalog's own (daily moving averages before weekly). That top-level grouping is Strategy
metadata the catalog does not define, so it lives here once.

The legacy builder prioritized a "Most used" section that was reordered per BUY/SELL tone
(`displayPriorityByTone` in `ConditionBuilder.tsx`). **Do not port it.** Invariant 9 forbids a
second ordering array in feature code, and the value it added is small next to the cost of a
divergent order. If it is wanted later it must become registry metadata, not component state.

### Human-readable rendering

```ts
export type StrategyPreviewLine =
  | { kind: "LEVEL"; levelKind: StrategyLevelKind; index?: number; percentage?: number }
  | { kind: "CONDITION"; text: string; connector?: "AND" }
  | { kind: "TRIGGER"; text: string }
  | { kind: "EMPTY"; levelKind: StrategyLevelKind };

describeCondition(condition): string
describeTrigger(trigger): string
describeStrategy(definition): readonly StrategyPreviewLine[]
```

Structured lines, not one string. The legacy implementation generated a formula string and then
re-parsed it with regular expressions to humanize it (`humanizeSingleClause` in
`generated-strategy-logic.ts` matches `/^([A-Z0-9_]+)\s+is\s+(above|below|close to)\s+(.+)$/`).
Generating structure once and rendering it removes that round trip entirely and lets the UI tone
each line by level kind.

---

## 4. Strategy validation

Two entry points over one rule set, mirroring `normalizeBuyWindowConfiguration` /
`BuyWindowValidationError` in `@intrinsic/domain`:

```ts
/** Non-throwing, path-addressed. The Builder renders these inline. */
validateStrategyDefinition(definition: unknown): readonly StrategyValidationIssue[]

/** Throws StrategyValidationError; returns the canonical persisted form. The API uses this. */
normalizeStrategyDefinition(definition: unknown): StrategyDefinition
```

`normalizeStrategyDefinition` calls `validateStrategyDefinition` first, so a rule can never be
enforced in one path and not the other.

```ts
export type StrategyIssuePath = {
  levelKind: StrategyLevelKind;
  levelIndex?: number;      // absent for FINAL_EXIT and strategy-level issues
  part: "STRATEGY" | "NAME" | "LEVEL" | "PERCENTAGE" | "CONDITION" | "TRIGGER";
  conditionIndex?: number;
  field?: "METRIC" | "OPERATOR" | "VALUE";
};

export type StrategyValidationIssue = {
  code: StrategyValidationCode;
  path: StrategyIssuePath;
  message: string;   // user-facing, product vocabulary only
};
```

The path is the load-bearing part: it is what lets **one** validator drive both the inline field
errors in the Builder and the API's 400 body, with no second mapping.

Rules, each with its own `StrategyValidationCode`:

| Code | Rule | Source |
| --- | --- | --- |
| `SIGNAL_EMPTY` | every Signal has at least one Condition or a Trigger | `strategies.md` § Validation |
| `OPERATOR_NOT_SUPPORTED` | operator is in the metric's registry entry | § Validation |
| `VALUE_KIND_MISMATCH` | Value kind matches the metric's `StrategyValueSpec` | § Validation |
| `VALUE_OUT_OF_DOMAIN` | percentage/numeric Value inside its **metric's own** domain, and finite: MOS `<= 100`, `Gain` `>= -100`, `Loss` `0…100`, RSI `1…100` | § Validation |
| `SERIES_UNKNOWN` | every `SelectableSeriesId` resolves via `findSelectableSeries` | § Validation |
| `SERIES_NOT_COMPARABLE` | a `SERIES` Value is in the metric's permitted subset — for a moving-average Metric, exactly `comparableMovingAverages(seriesId)`, so a self-comparison or a daily/weekly pair is rejected | § Validation |
| `METRIC_NOT_ALLOWED_IN_LEVEL` | no `GAIN`/`LOSS` in a BUY level | § Validation |
| `PERCENTAGE_INVALID` | BUY ∈ {25,50,75,100}, SELL ∈ {25,50,75} | § Validation |
| `NAME_REQUIRED` / `NAME_TOO_LONG` | 1…`STRATEGY_NAME_MAX_LENGTH` after trim | Builder |
| `DUPLICATE_CONDITION` | two **semantically** identical Conditions in one Signal — same Metric, same operator, same Value; never object or row identity, and never silently deduped | `strategies.md` § Validation |
| `BUY_LEVEL_REQUIRED` | at least one BUY level | `strategies.md` § Strategy shape |
| `TOO_MANY_LEVELS` / `TOO_MANY_CONDITIONS` | within the exported limits | Builder |

Shared limits exported beside the types, matching the lists slice's precedent:

```ts
STRATEGY_NAME_MAX_LENGTH = 120;
STRATEGY_DESCRIPTION_MAX_LENGTH = 500;
STRATEGY_MAX_BUY_LEVELS = 10;
STRATEGY_MAX_SELL_LEVELS = 10;
STRATEGY_MAX_CONDITIONS_PER_SIGNAL = 10;
```

Normalization is deterministic and idempotent: trim the name, drop an empty description to
`undefined`, coerce numeric values to finite numbers at the registry step, preserve level order
exactly (it is product-meaningful), and never reorder or merge conditions.

---

## 5. Persistence and schema

```prisma
/// User-owned strategy identity. Editing never mutates a saved version: a definition change
/// appends a new `StrategyVersion`, so a strategy referenced by a completed backtest can never be
/// altered retroactively.
model Strategy {
  id          String            @id @default(uuid())
  userId      String
  name        String
  description String?
  createdAt   DateTime          @default(now())
  updatedAt   DateTime          @updatedAt
  user        User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  versions    StrategyVersion[]

  @@index([userId])
  @@index([userId, updatedAt])
}

/// One immutable definition. `definition` is written once and never updated; the highest
/// `versionNumber` is the current one, so no pointer column and no circular relation is needed.
model StrategyVersion {
  id             String   @id @default(uuid())
  strategyId     String
  versionNumber  Int
  definition     Json
  definitionHash String
  createdAt      DateTime @default(now())
  strategy       Strategy @relation(fields: [strategyId], references: [id], onDelete: Cascade)

  @@unique([strategyId, versionNumber])
  @@index([strategyId])
}
```

**Why versioning now, in the Builder slice.** It does not change what a user can define, so it is
not a deferred backtest question — it is a persistence-shape decision, which this slice owns.
`ai/product/backtests.md` states that changing a Strategy after submission never changes a
completed or running backtest. Building Create/Edit against a single mutable row would make that
invariant impossible to honour without later rewriting the save path *and* migrating existing user
data. One extra table now costs a `@@unique` and an insert; retrofitting later costs a migration
plus a change to every read path. The Builder itself only ever reads the highest version.

**Why a JSON document rather than normalized tables.** A normalized shape would need four or five
tables (level, signal, condition, trigger) joined on every read, and would be mutable by accident —
the opposite of what an immutable version needs. Nothing queries inside a definition in SQL. One
never-updated column makes immutability structural. `schemaVersion: 1` inside the document is the
migration handle, and the API parses every definition through `normalizeStrategyDefinition` on
read, so a drifted document fails loudly instead of reaching the UI.

This does **not** reopen `docs/decisions/retain-wide-column-calculated-series-storage.md`. That
decision is about *calculated series*, which are queried by date range, are numeric columns and are
rebuilt by revision. A strategy definition is a small user-authored document read whole by primary
key. Record the difference explicitly in a short ADR, `docs/decisions/strategy-definition-storage.md`,
alongside the migration note `AGENTS.md` requires.

**Versioning rule.** `definitionHash` is a stable hash of the normalized definition **with the
level/condition/trigger ids stripped**. On save, if the hash equals the current version's, no row
is written. Name and description changes live on `Strategy` and never create a version.

---

## 6. API contracts and CRUD

New slice `apps/api/src/strategies/`, mirroring `apps/api/src/lists/` file for file:
`strategies.controller.ts`, `strategies.service.ts`, `strategy-requests.ts`, `strategies.module.ts`,
`strategies.tokens.ts`, `strategies.integration.test.ts`.

| Method | Route | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/strategies` | — | `StrategySummaryResponse[]` |
| `POST` | `/strategies` | `CreateStrategyRequest` | `StrategyDetailResponse` |
| `GET` | `/strategies/:id` | — | `StrategyDetailResponse` |
| `PATCH` | `/strategies/:id` | `UpdateStrategyRequest` (name/description) | `StrategySummaryResponse` |
| `PUT` | `/strategies/:id/definition` | `ReplaceStrategyDefinitionRequest` | `StrategyDetailResponse` |
| `DELETE` | `/strategies/:id` | — | `204` |

The shape is deliberately the lists slice's: `POST` create, `GET` detail, `PATCH` metadata,
`PUT` whole-configuration replace, `DELETE`. `PUT /definition` is the direct analogue of
`PUT /lists/:listId/items/:itemId/buy-windows` — it replaces the **complete** configuration
atomically and returns the canonical normalized result, which is exactly what was persisted.

```ts
export type StrategySummaryResponse = {
  id: string; name: string; description?: string;
  buyLevelCount: number; sellLevelCount: number; hasFinalExit: boolean;
  versionNumber: number; createdAt: string; updatedAt: string;
};

export type StrategyDetailResponse = StrategySummaryResponse & {
  definition: StrategyDefinition;
};

/** `definition` lets the create flow save a name plus the rules in one atomic request. */
export type CreateStrategyRequest = {
  name: string; description?: string; definition?: StrategyDefinition;
};
/** At least one field. `description: null` clears it. */
export type UpdateStrategyRequest = { name?: string; description?: string | null };
export type ReplaceStrategyDefinitionRequest = { definition: StrategyDefinition };
```

The summary carries counts rather than the definition so the collection page renders without
loading every document — the same reasoning as `StockListSummaryResponse.itemCount`.

**Service.** `StrategiesService` scopes every query by the authenticated user id and raises
`StrategyNotFoundError` for a strategy that does not exist *or* belongs to someone else, so knowing
another user's id reveals nothing. No ADMIN bypass. Structured logging through a
`STRATEGIES_LOGGER` provider with `component: "strategies"`, `actorUserId` and the strategy id.

**Request parsing.** Hand-written parsers in `strategy-requests.ts`, matching the repository's
existing approach — there is no validation library in the workspace and none should be added. The
parser checks the envelope (types, lengths, unknown top-level keys) and delegates the definition to
`normalizeStrategyDefinition` from contracts. **Rejecting unknown keys is a real rule, not
tidiness**: it is what stops a `stockListId`, `initialCapital` or `maximumPositions` field from
ever being accepted into a Strategy.

**Error mapping** in the controller's `execute` helper, exactly as `ListsController` does:
`StrategyNotFoundError` → 404; `StrategyValidationError` → 400 carrying
`{ message, code: "STRATEGY_INVALID", issues }`. Anything unrecognized stays a 500.

**One small client extension.** `apps/web/src/lib/api/client.ts`'s `ApiError` currently reads only
`message` and `code`; add an optional `issues` payload so a 400 can be attached to the offending
rows. This is defence in depth — the Builder validates with the same shared validator, so a
UI-driven save should never produce a 400 — but a stale client or a concurrent edit can, and a
generic banner would be a dead end for the user.

---

## 7. Frontend state and component boundaries

```text
apps/web/src/features/strategies/
  api/strategies-api.ts
  hooks/
    use-strategies.ts        # collection: load, create, rename, delete
    use-strategy.ts          # one strategy: loading | ready | not-found | error
    use-strategy-draft.ts    # React binding for the draft reducer + dirty/validity
  components/
    StrategiesPage.tsx       # collection view
    StrategyBuilder.tsx      # layout shell: editor column + explanation panel
    StrategyDetailsCard.tsx  # name, description
    LevelSection.tsx         # "BUY levels" / "SELL levels" container + add button
    LevelCard.tsx            # one level: tone, ordinal, percentage, remove, reorder
    SignalEditor.tsx         # Conditions block + optional Trigger block
    PredicateRow.tsx         # Metric / operator / Value — one component, two modes
    MetricSelect.tsx  OperatorSelect.tsx  ValueControl.tsx
    LevelPercentageSelect.tsx
    ExplanationPanel.tsx     # desktop right column
    LogicPreview.tsx         # renders StrategyPreviewLine[]
    UnsavedChangesBar.tsx
  utils/
    strategy-draft.ts        # pure reducer + action creators
    strategy-issues.ts       # groups issues by StrategyIssuePath for lookup
```

State boundaries, each owning exactly one thing:

- **Draft** — a `useReducer` over `{ name, description, definition }`. The reducer lives in
  `utils/strategy-draft.ts` as a pure function so it is unit-testable without React. Actions:
  `addLevel`, `removeLevel`, `moveLevel`, `setPercentage`, `addCondition`, `removeCondition`,
  `setMetric`, `setOperator`, `setValue`, `setTrigger`, `removeTrigger`, `setName`,
  `setDescription`, `reset`.
- **Cascading resets belong in the reducer, not in components.** `setMetric` must clear an operator
  the new metric does not support and replace the Value with `defaultValueFor(...)`; `setOperator`
  must do the same for the Value. Doing this in the reducer is what makes an invalid intermediate
  state unreachable rather than merely flagged.
- **Validation** — derived, never stored:
  `useMemo(() => validateStrategyDefinition(draft), [draft])`. No component holds a rule.
- **Touched fields** — a `Set<string>` of issue-path keys, for the "show errors after touch"
  behaviour in § 10. UI-only, separate from the draft.
- **Focus context** — which predicate row or control is active, driving the explanation panel.
  UI-only, separate from the draft, so typing in a row does not re-render the whole editor.
- **Server state** — `use-strategy` mirrors `use-stock-list` exactly, including treating 404 as a
  product state rather than an error.

Two rules that keep the boundary honest:

1. **No component holds an options array.** Every select's options come from a registry function.
2. **No component computes compatibility, formats a predicate sentence, or knows a limit.** Those
   come from `@intrinsic/contracts`.

Save is **explicit, never autosave**. A strategy is a coherent document; autosaving would persist
incoherent intermediate states and, with the hash rule, churn versions.

---

## 8. Desktop composition

Two-column split activates at **1280px** — the shell's existing wide-desktop breakpoint, and the
same point the legacy builder used (`xl:grid-cols-[1.2fr_0.8fr]`). Between 880px and 1280px the
Builder is single-column with desktop padding and the inline explanation treatment from § 9; the
three-select row plus a useful panel does not fit below 1280px without compressing both.

```css
.builder {
  display: grid;
  gap: 24px;
  grid-template-columns: minmax(0, 1fr);
}
@media (min-width: 1280px) {
  .builder { grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr); }  /* 67% / 33% */
  .panel {
    position: sticky;
    top: calc(var(--topbar-height-wide) + 16px);
    max-height: calc(100vh - var(--topbar-height-wide) - 32px);
    overflow-y: auto;
  }
}
```

`2fr / 1fr` lands at 66.7% / 33.3%, inside the 65–70% / 30–35% the product document specifies, and
the `minmax(300px, …)` floor stops the panel collapsing to an unreadable column.

**Editor column order**: strategy details card → BUY levels → SELL levels → FINAL EXIT → (nothing
else; there is no Stock List, period, capital or `maximumPositions` control anywhere on this page).

**Level card anatomy.**

```text
┌─────────────────────────────────────────────────────────┐
│ ▌ BUY 1        [25% ▾] of a full position      ↑ ↓  ✕   │   ← 3px tone accent, chip, percentage
├─────────────────────────────────────────────────────────┤
│ CONDITIONS                                              │
│  [Price          ▾] [is above  ▾] [EMA 200D    ▾]   ✕   │
│  AND                                                    │
│  [RSI 14D        ▾] [is below  ▾] [   30       ]    ✕   │
│  + Add condition                                        │
├─────────────────────────────────────────────────────────┤
│ TRIGGER (OPTIONAL)                                      │
│  [Price          ▾] [crosses above ▾] [EMA 50D ▾]   ✕   │
└─────────────────────────────────────────────────────────┘
```

Predicate row grid:
`grid-template-columns: minmax(150px, 1.3fr) minmax(130px, 0.9fr) minmax(150px, 1.3fr) 32px`.
The Metric and Value columns are equally weighted so the row reads as a sentence rather than
tapering. `AND` connectors render between condition rows, not as a control — the product forbids
exposing boolean-expression vocabulary as an editable operator.

**Tone.** BUY = `--color-positive` / `--color-positive-soft`, SELL = `--color-negative` /
`--color-negative-soft`, FINAL EXIT = `--color-warning` / `--color-warning-soft`, drawn as a 3px
left accent plus a soft-background chip. The legacy builder used amber for SELL and red for FINAL
EXIT (`TONE_STYLES` in `ConditionBuilder.tsx`); `ai/architecture/frontend.md` assigns red to
negative/sell and orange to warning/final-exit, and **V2 wins**. No new colors are needed — the
three semantic tokens already exist in `styles/tokens.css`.

**Density.** 32px control height, 13px control text, `--radius-control`. This is a deliberate step
up from the legacy 28px/11px: it stays clearly denser than default browser form controls, which is
what the product document asks for, while remaining legible and touch-viable in the single-column
band.

---

## 9. Mobile composition

A dedicated composition, not the desktop grid narrowed. Single column below 1280px; the treatments
below apply below 600px unless stated.

**Predicate row — two lines, never clipped, never horizontally scrolled:**

```text
┌───────────────────────────────────────┐
│ ▌ BUY 1                        ↑ ↓ ✕  │
│   [ 25% ] [ 50% ] [ 75% ] [ 100% ]    │  ← segmented control, not a select
├───────────────────────────────────────┤
│ CONDITIONS                            │
│  [ Price                    ▾ ]   ✕   │  ← line 1: metric + remove
│  [ is above  ▾ ] [ EMA 200D    ▾ ]    │  ← line 2: operator + value
│  ⓘ  Price is above EMA 200D …         │  ← inline explanation, focused row only
│  AND                                  │
│  [ RSI 14D                  ▾ ]   ✕   │
│  [ is below  ▾ ] [    30       ]      │
│  + Add condition                      │
└───────────────────────────────────────┘
```

- Line 2 stacks to two full-width rows below **360px**, where `is above` + `EMA 200D` stops fitting.
- Level percentage becomes a **segmented control**, not a select: four fixed options are faster to
  tap than a picker, and it echoes the legacy builder's mobile habit of replacing small numeric
  inputs with preset choices.
- RSI and percentage Values keep a numeric input with `inputMode="numeric"`; V1 does not need the
  legacy mobile preset-select because `is close to` has no tolerance control (the 2% tolerance is a
  fixed product constant) and RSI is a free 1…100 value.
- The remove control is a trailing icon on line 1, so it never claims a row of its own.
- Section labels (`CONDITIONS`, `TRIGGER (OPTIONAL)`) stay visible on mobile: they are what keeps
  the Condition/Trigger distinction legible without a right-hand panel.

**Explanation on mobile.** The desktop panel's content moves to the control it explains: focusing a
predicate row discloses a short explanation directly beneath that row, collapsing when focus moves
elsewhere. Longer help and the full logic preview live in a collapsible **"How this strategy
reads"** section at the end of the flow, so they cost no vertical noise until opened.

**Save bar.** Fixed above the bottom navigation, respecting the safe area:

```css
.saveBar { position: fixed; left: 0; right: 0;
  bottom: calc(var(--bottom-nav-height) + var(--safe-area-bottom)); }
.builder { padding-bottom: calc(var(--bottom-nav-height) + 56px + var(--safe-area-bottom)); }
```

Losing unsaved rule edits is worse than 56px of chrome. Above 880px the bottom navigation is gone
and the save action moves into the sticky page header.

**Acceptance, not polish.** Mobile behaviour ships in the same phase as the feature, per
`AGENTS.md` § Frontend rules. The Playwright mobile run (§ 11) asserts no horizontal scrolling.

---

## 10. Contextual explanation and logic preview

**Content lives in contracts**, beside the registry, keyed by the same identities:

```ts
STRATEGY_METRIC_HELP: Record<StrategyMetricKind, { summary: string; detail: string }>
STRATEGY_OPERATOR_HELP: Record<ConditionOperator | TriggerOperator, { summary: string; detail: string }>
```

Feature code must not hold help strings, for the same reason it must not hold labels: two surfaces
explaining the same operator differently is the drift invariant 9 exists to prevent.

Content the panel must carry, all of it already written in `ai/product/strategies.md`:

- **Margin of Safety**, which is the metric that most needs it: what MOS means, the canonical
  formula with Intrinsic Value as the denominator, a worked numeric example, the distinction from
  upside (`(100-75)/100 = 25%` versus `(100-75)/75 = 33.33%`), and the meaning of positive, zero and
  negative values. The rule row stays three fields — there are no formula-configuration inputs,
  because the intrinsic source is part of the Metric and the formula is fixed;
- **moving-average Metrics**: that the offered Values are the compatible same-timeframe averages,
  and that daily and weekly averages are not compared in V1;

- the **Condition vs Trigger distinction**, using the product's own contrast — a state that stays
  true across days versus the single event that fires while it is true. The document's worked
  example is the best possible panel content:

  ```text
  Price is above EMA 50D      false false true  true  true  false
  Price crosses above EMA 50D false false true  false false false
  ```

- `is close to` means **within 2%**, a fixed product constant and not an input;
- MOS sign convention: positive means price below intrinsic value, `0%` at it, negative above, and
  MOS is `NOT_EVALUABLE` when the point-in-time intrinsic value is `<= 0`;
- `Gain` is signed and `Loss` is clamped at zero, so `Loss is above 10%` means the price is more
  than 10% below the position's average cost;
- warm-up: a rule cannot be evaluated on days where its series has no value yet, and such a day
  never produces a signal.

**What the panel must not say.** It must not describe execution behaviour that is still an open
backtest question — whether a level fires once or repeatedly, what happens when two levels match,
or how SELL and FINAL EXIT interact on one date. Explanations describe **the signal**, never the
lifecycle. This is the concrete guard that keeps the deferred questions from leaking into the
product surface as invented behaviour.

**Logic preview** renders `describeStrategy(definition)` — structured lines, toned per level kind:

```text
BUY 1 · 25% of a full position
    Price is above EMA 200D
    AND RSI 14D is below 30
    AND Price crosses above EMA 50D          (trigger)

SELL 1 · 50% of the remaining position
    Gain is above 25%

FINAL EXIT
    Price crosses below SMA 200D
```

It is **derived at render time and never persisted**. The legacy schema stored a
`generatedFormula` LongText column beside `configJson`; that is a second source of truth that goes
stale the moment rendering changes, and V2 has no need for it.

An incomplete level renders an explicit placeholder line (`kind: "EMPTY"`) rather than vanishing,
so the preview shows what is missing instead of silently under-reporting the strategy.

---

## 11. Validation and error UX

**When errors appear.** Never on first render of a new strategy — an empty builder would open to a
wall of red. A field's issue renders once that field is **touched**, or once **Save has been
attempted**. The issue count is always visible in the action bar but stays neutral until a save
attempt.

**Where errors appear.** `strategy-issues.ts` groups issues by `StrategyIssuePath` into a lookup
keyed by level and condition index, so each control asks for its own:

- field issues (`METRIC`/`OPERATOR`/`VALUE`) render under the control, with `aria-invalid` and
  `aria-describedby`;
- level issues (`SIGNAL_EMPTY`, `PERCENTAGE_INVALID`) render inside the level card header area;
- strategy issues (`NAME_REQUIRED`, `BUY_LEVEL_REQUIRED`, `TOO_MANY_LEVELS`) render next to the
  field or at the top of the editor column.

**Save affordance.** Save is enabled only when the draft is dirty **and** has no issues. A disabled
button with no explanation is a dead end, so the action bar shows `3 issues to fix`, and clicking it
scrolls to and focuses the first issue in document order.

**Other states**, all part of the feature rather than later polish: loading skeleton for
`/strategies/:id`; a distinct not-found state for a 404 (mirroring `use-stock-list`); a retryable
error state; a save-failure banner that maps a 400's `issues` back onto rows when present; and an
unsaved-changes guard on navigation away from a dirty draft.

---

## 12. Test plan

### Contracts — unit (`vitest`)

Registry integrity, which is where invariant 9 is actually enforced:

- every metric definition has at least one condition operator, a value spec, and a non-empty
  `allowedIn`;
- every `SelectableSeriesId` the registry references resolves through `findSelectableSeries`;
- `GAIN` and `LOSS` are absent from `strategyMetricOptions("BUY")`;
- `IS_CLOSE_TO` appears for `PRICE` and `MOVING_AVERAGE`, and for no other metric;
- for every moving-average Metric, `valueSpecFor` returns exactly
  `comparableMovingAverages(seriesId)`: the metric's own id is absent, and no entry has the
  other timeframe;
- percentage domains are per metric — MOS accepts `-250` and `100` but not `100.01`; `Gain`
  accepts `-100` and `1000` but not `-100.01`; `Loss` accepts `0` and `100` but neither `-0.01`
  nor `100.01`; all three accept decimals;
- `PRICE_COMPARABLE_SERIES` contains no oscillator and has 21 entries derived from the catalog;
- **label parity**: for every catalog-backed metric and value, the label the registry produces
  equals `findSelectableSeries(id).label` (or, for MOS, exactly one composition of it). This is the
  test that makes "one label, one ordering" true rather than aspirational.

Validator — one test per `StrategyValidationCode`, each asserting the exact `path`, plus:
`normalize(normalize(x))` deep-equals `normalize(x)`; the hash is unchanged when only ids change and
**changed** when level order changes; a definition carrying a `stockListId` or `maximumPositions`
key is rejected.

`describeStrategy` — a snapshot over a strategy exercising every metric kind, both operator
families, an empty level and a level with a trigger.

### API — integration (`useTestDatabase()`, per `ai/workflows/validation.md`)

`apps/api/src/strategies/strategies.integration.test.ts`, registered in that document's caller list:

- full lifecycle: create → get → patch name → put definition → delete;
- ownership isolation: another user's strategy answers 404 identically to a missing one;
- an invalid definition returns 400 with `issues` and persists **nothing**;
- `PUT /definition` with an unchanged normalized definition creates **no** new version row;
- a real change increments `versionNumber` and leaves the previous version intact;
- an unknown catalog series id → 400; `Gain` in a BUY level → 400;
- an unknown top-level body key → 400.

### Web — component (`vitest` + Testing Library)

- `strategy-draft` reducer as a pure function: add/remove/reorder levels; `setMetric` from `Price`
  to `RSI 14D` clears an unsupported operator and installs the default numeric Value;
  `setOperator` to a trigger operator keeps a compatible Value and replaces an incompatible one;
- `PredicateRow`: switching Metric swaps the Value control from a series select to a numeric input
  and narrows the operator list;
- `MetricSelect` inside a BUY level offers no `Gain`/`Loss`;
- an inline error is absent before touch and present after;
- `LogicPreview` renders `AND` connectors, marks the trigger line, and shows a placeholder for an
  empty level;
- composition mode is passed as a **prop**, not read from `matchMedia`, so the mobile disclosure
  behaviour is testable in jsdom, which has no real layout.

### Playwright — `apps/web/e2e/strategies/strategies.user.spec.ts` (`user` project)

One journey, signed in as `QA_USER` through the existing `signInThroughUi` helper: open
`/strategies` → create → name it → add a BUY level with a condition and a trigger → add a SELL level
using `Gain` → add FINAL EXIT → assert the preview sentences → save → reload → assert persistence →
edit one condition → save → delete. Tag the create-and-save path `@smoke`.

A second run at a phone viewport covering the same core steps, asserting: `scrollWidth <=
clientWidth` on the scrolling element (no horizontal scrolling to define a Signal), the explanation
discloses beneath the focused row, and the save bar sits above the bottom navigation.

**No stock-data seeding is needed for either.** The catalog is static in contracts, so these suites
never reach FMP, Redis or the loader.

---

## 13. Phased implementation order

Each phase is one reviewable PR that leaves the repository working.

| Phase | Content | Depends on |
| --- | --- | --- |
| **A** | `packages/contracts/src/strategies.ts`: types, registry, validator, normalizer, `describeStrategy`, help content, limits + full unit suite | — |
| **B** | Prisma models + migration + migration note + `docs/decisions/strategy-definition-storage.md`; `apps/api/src/strategies/` slice + integration suite | A |
| **C** | Web data layer: `strategies-api.ts`, `use-strategies`, `use-strategy`; `/strategies` collection page with create, rename, delete | B |
| **D** | Builder core: draft reducer, level/signal/predicate components, desktop composition, validation UX; `/strategies/new` and `/strategies/[id]` | A, C |
| **E** | Explanation panel and logic preview | A, D |
| **F** | Mobile composition and responsive verification | D, E |
| **G** | Playwright desktop + mobile journeys; full validation gate | C–F |

Phases A and B are backend-only and unblock everything else. The slice becomes usable at D; E and F
complete the product document's Builder UX requirements. Routes are `/strategies` (collection),
`/strategies/new` (create) and `/strategies/[id]` (edit) — the Builder is the detail view, with the
logic preview serving as its read surface, so no separate read-only page is needed.

---

## 14. Decisions required now, and what stays deferred

### Required for the Builder — recommended answers

| # | Decision | Recommendation |
| --- | --- | --- |
| N1 | May a moving average be a **Metric**? | **Yes.** MA-vs-MA Conditions and Triggers are supported in V1; the permitted Values come from `comparableMovingAverages(seriesId)` — same timeframe, never itself, never inferred from numeric similarity. All five operators apply, and `is close to` uses the fixed 2% rule. |
| N2 | Percentage Value domains | **Metric-specific, not one shared range:** MOS `<= 100`, `Gain` `>= -100`, `Loss` `0…100`, decimals allowed on all three. |
| N3 | Versioning now or later? | **Now.** `Strategy` + `StrategyVersion`; a definition change appends a version, name/description changes do not. |
| N4 | Definition storage shape | **JSON document with `schemaVersion`**, parsed through the normalizer on read. Short ADR recording why this does not reopen the calculated-series decision. |
| N5 | Save semantics | **Explicit save**, no autosave; a new version only when the id-stripped hash changes. |
| N6 | BUY / SELL / FINAL EXIT color mapping | **`--color-positive` / `--color-negative` / `--color-warning`.** Resolves the legacy conflict (amber SELL, red EXIT) in favour of the V2 tokens. |
| N7 | Legacy "Most used" metric prioritization | **Do not port.** A per-tone reordering array in feature code violates invariant 9. |
| N8 | Level reordering in the UI | **Yes, via up/down buttons** — accessible, and simpler than drag-and-drop. Order is persisted because the engine will use it. |
| N9 | Shared limits | Name 120, description 500, 10 BUY levels, 10 SELL levels, 10 conditions per signal. |

### Deferred — backtest-only, unchanged in `strategy-evaluation.md`

Questions 1, 2, 3, 4, 6, 7, 8, 9 and 13 of that document stay open and stay out of this slice:
repeated BUY levels during an open position, SELL level repetition, SELL vs FINAL EXIT precedence,
multiple levels matching on one date, candidate ordering under scarcity, execution price and fees,
contribution timing, currency mixing, and exits-before-entries.

Three of that document's questions were closed by the Strategy-facing decisions above and are now
recorded in `ai/product/strategies.md`, not re-litigated here: MOS with a non-positive intrinsic
value (`NOT_EVALUABLE`), the shape of `Loss` (clamped at zero, not an unclamped mirror of `Gain`),
and whether a moving average may be a Metric (yes). Question 5 is narrowed rather than closed:
`Gain`/`Loss` are canonically measured against **average cost**, and only how average cost evolves
across repeated BUYs and partial SELLs remains execution behaviour.

None of them changes what a user can define. Each describes what the **engine does** with a saved
Strategy, and the Builder saves the same document under every possible answer. The one obligation
they place on this slice is the guard in § 10: **explanation text describes the signal, never the
lifecycle**, so no deferred answer is implied to users before it is decided.

---

## 15. Strategy Builder product decisions — closed

Every Builder-blocking product question is now answered and canonical in
`ai/product/strategies.md`. **There are no unresolved Strategy Builder product questions.**

| Was | Decision | Canonical in |
| --- | --- | --- |
| B1 — May a moving average be a Metric? | **Yes.** MA-vs-MA Conditions and Triggers are supported. Permitted Values come from `comparableMovingAverages(seriesId)`: same timeframe, never itself, never inferred from numeric similarity. Operators: `is above`, `is below`, `is close to`, `crosses above`, `crosses below`, with the fixed 2% rule for `is close to`. | `strategies.md` § Moving averages, § Metric compatibility table |
| B2 — Minimum saveable Strategy | **At least one BUY level.** SELL levels and FINAL EXIT stay optional; Signal rules are unchanged. No backtest configuration enters Strategy. | `strategies.md` § Strategy shape, § BUY levels, § Validation rules |
| B3 — Percentage Value domains | **Metric-specific semantic domains, never one shared range.** MOS: finite `<= 100`, no lower bound. `Gain`: finite `>= -100`, no upper bound, signed. `Loss`: `0…100`, clamped at zero. Decimals allowed throughout. | `strategies.md` § Margin of Safety, § Gain and Loss |
| B4 — Duplicate Conditions | **Rejected**, with a path-addressed issue pointing at the duplicated row. Never silently deduped. Identity is semantic, not object or row identity. | `strategies.md` § Validation rules |
| B5 — Strategy name uniqueness | **Not unique per user.** Identity is the Strategy id; no `(userId, name)` constraint. | `strategies.md` § Strategy shape |

Two canonical definitions were made explicit at the same time and are now product, not inference:

- **Margin of Safety** is `(Intrinsic Value - Price) / Intrinsic Value * 100`. The denominator is
  Intrinsic Value, never Price, and MOS is not upside. It is `NOT_EVALUABLE` when the point-in-time
  intrinsic value is `<= 0`, and each MOS metric reads only its own explicitly selected
  intrinsic-value series under the existing point-in-time rules.
- **Gain and Loss** are measured against average cost: `Gain` is signed, `Loss` is
  `max(0, (AverageCost - Price) / AverageCost * 100)`. Both remain position-dependent and remain
  unavailable in BUY rules.

Phase A can now freeze the registry.
