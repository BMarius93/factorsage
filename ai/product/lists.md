# Stock Lists

A `StockList` is a user-owned, named, reusable stock universe. Later features — strategies,
backtests, monitoring — consume lists as their universe input, so the concept is deliberately
generic (`StockList`, not `Watchlist`).

## Model

```text
User
 └─ StockList            (name, optional description)
     └─ StockListItem    (buyWindowMode FULL | CUSTOM)
         ├─ Security     (canonical catalog identity, referenced by securityId)
         └─ StockListBuyWindow[]  (CUSTOM only; canonical normalized ranges)
```

- `Security` is the stock identity authority. Membership persists only `securityId` foreign keys,
  never free-text symbols. Adding a stock validates it against the existing catalog; the list
  feature never creates `Security` rows and never calls FMP. A stock outside the catalog is
  unsupported for membership.
- A security may appear at most once per list (`@@unique([stockListId, securityId])`); adds are
  idempotent (`createMany skipDuplicates`), so retries and concurrent submissions converge.
- Deleting a list cascades its items; deleting an item cascades its buy windows.
  `StockListItem.securityId` is `onDelete: Restrict`: catalog rows are never product-deleted, and
  user list data must not vanish through a catalog mutation.
- Rendering lists uses list data plus catalog identity only — never price/fundamentals/intrinsic
  hydration.

## Ownership and authorization

Every list belongs to exactly one user. All `/lists` endpoints require authentication, and the
service layer scopes every query by the authenticated user id. A list that exists but belongs to
someone else answers exactly like one that does not exist (404 with the identical message), so a
leaked list id reveals nothing. There is intentionally no ADMIN bypass; an admin surface would be
a deliberate future endpoint. The browser UI is presentation only — the API/service layer is the
authorization authority.

## Buy windows

Each list item independently restricts when a future strategy/backtest may open a **new BUY** in
that stock. Selling is never restricted.

```text
FULL    eligible on every date the strategy/backtest covers; zero persisted rows
CUSTOM  eligible only inside one or more date ranges; at least one persisted row
```

`StockListBuyWindow` rows are inclusive calendar dates (`@db.Date`, `YYYY-MM-DD`).
`endDate = null` means open-ended. A null `startDate` does not exist — unrestricted history is
mode `FULL`, not an unbounded range.

### Canonical normalization invariant

The persisted ranges of one item are always the canonical set: chronologically sorted, maximal,
non-overlapping, non-adjacent, with at most one open-ended range as the final entry. Two inputs
describing the same eligible dates always persist identically.

`normalizeBuyWindowConfiguration` in `@intrinsic/domain` (`stock-lists.ts`) owns this logic:
validate every range (`startDate <= endDate` when bounded), sort, merge overlapping ranges, merge
directly adjacent ranges (one continuous eligibility period), and let an open-ended range absorb
everything at or after its start. Merging never invents eligibility beyond the union of the input.
`FULL` submitted with ranges is rejected (a silent discard would hide a client bug); `CUSTOM` with
zero ranges is rejected.

The API replaces an item's complete configuration atomically
(`PUT /lists/:listId/items/:itemId/buy-windows`) inside one transaction and returns the canonical
result; there is no incremental range endpoint. Switching CUSTOM → FULL deletes every persisted
row. The browser may pre-validate, but the API response is what gets rendered after save.

Do not reintroduce index-membership PIT through list semantics.

## Mutability and the backtest reproducibility invariant

A `StockList` is mutable configuration. **A completed or running backtest must never depend on the
current state of a list.** When backtests are implemented, their input must snapshot the selected
universe and each member's buy-window configuration at submission time, so editing or deleting a
list later cannot retroactively change historical results. Today's schema keeps that cheap: one
item plus its window rows is a small self-contained value that can be copied into a snapshot
structure.

## API surface

All routes require the session cookie; bodies are parsed by `stock-list-requests.ts` against the
shared limits in `@intrinsic/contracts` (`stock-lists.ts`).

```text
GET    /lists                                   summaries with item counts
POST   /lists                                   create; optional initial securityIds (atomic)
GET    /lists/:listId                           detail with items + buy windows
PATCH  /lists/:listId                           rename / update or clear description
DELETE /lists/:listId                           delete with cascades
POST   /lists/:listId/items                     idempotent batch add by securityIds -> detail
DELETE /lists/:listId/items/:itemId             remove one membership
PUT    /lists/:listId/items/:itemId/buy-windows replace complete configuration -> canonical item
```

Structured events (`component: stock-lists`, `actorUserId` from the request context):
`stock-list.created/updated/deleted`, `stock-list.items.added`, `stock-list.item.removed`,
`stock-list.buy-windows.updated`.

## Frontend

`apps/web/src/features/lists/` with routes `/lists` and `/lists/[id]`. The membership picker
(`SecurityMultiSelect`) is a chips combobox built on the same `useStockSearch` hook as the global
topbar search — one search behavior, catalog-only, and Enter can only select a real result, never
free text. List creation stays fast: name + stock selection; buy windows are edited afterwards on
the list page through a per-stock editor dialog.

## Testing

- Normalization: `packages/domain/src/stock-lists.test.ts`.
- API + ownership + cascades: `apps/api/src/lists/stock-lists.integration.test.ts`
  (`useTestDatabase()`, randomized isolated users and catalog rows — never QA personas).
- UI: `apps/web/src/features/lists/**` component suites.
- E2E: `apps/web/e2e/lists/lists.user.spec.ts` needs the deterministic fictional QA catalog rows
  (`pnpm test:securities:seed`, `QATEST1`/`QATEST2`); it never assumes real market symbols exist.
