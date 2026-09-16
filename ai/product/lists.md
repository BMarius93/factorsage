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
- **A list a Monitor references cannot be deleted.** `Monitor.stockListId` is `onDelete: Restrict`,
  and `DELETE /lists/:listId` answers `409` naming how many Monitors still use it. A Monitor owns
  Signal history — a record of what was observed — so it must not disappear silently because its
  universe was deleted. The user deletes the Monitor first. See `monitors.md`.
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

> A Buy Window represents the period during which a List member is eligible for new BUY actions.
> It may correspond to point-in-time index membership. It does not constrain SELL actions for
> existing positions.

That paragraph is the definition; everything below is how it is enforced. Each list item
independently restricts when a strategy/backtest may open a **new BUY** in that stock, and equally
when a Monitor may report a **BUY** Signal for it. Selling is never restricted.

**The user-facing name is "membership".** `buyWindow` stays the internal name — schema, domain,
contracts, engine, Monitor — because it is what the mechanism _does_, and renaming it across the
repository would be churn without correctness. The browser says membership, because that is what a
user is describing when they set it: the period this stock was part of this list's universe.
Point-in-time index reconstruction is the case the multi-period model exists for — a security that
was in an index from 2001-03-10 to 2008-07-15, left, and rejoined on 2012-05-01 is one member with
two periods, and a backtest sitting in 2010 must not buy it.

This is a naming and UI decision, not a data one: the product still ships **no** historical index
membership dataset, and nothing reconstructs S&P 500 or Dow constituents for a user. A user (or an
import) supplies the periods; the product stores and honours them.

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

### Buy windows under a Monitor

A backtest covers a date range; a Monitor evaluates **one** date — its current observation. The same
eligibility rule applies to that single date:

- a BUY level produces no Signal for a symbol whose buy window does not admit the current
  observation date;
- SELL and FINAL EXIT are unrestricted, exactly as they are in a backtest.

`isBuyWindowEligible` in `@intrinsic/domain` is the one implementation of that question; the backtest
engine and the Monitor cycle both call it and neither restates it.

A Monitor's membership handling is deliberately **not** symmetric with a SELL: a member whose
window has closed stops producing BUY Signals and nothing else happens. Membership ending is not a
liquidation event, and there is no forced exit anywhere in the product.

Do not ship a historical index-membership dataset, and do not derive membership from anything but
the periods a user stored.

## Mutability and the backtest reproducibility invariant

A `StockList` is mutable configuration. **A completed or running backtest must never depend on the
current state of a list.** A backtest snapshots the selected universe and each member's buy-window
configuration at submission time, so editing or deleting a list later cannot retroactively change
historical results (`backtests.md`). A Monitor is the deliberate opposite: it snapshots nothing and
reads the list's current membership and windows at the start of every scan cycle, so an edit is
watched from the next cycle on and a removed member's active Signals are resolved by that cycle
(`monitors.md`, "Lifecycle in one place"). The two consumers of a list therefore answer "which
universe?" differently, and both on purpose.

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
free text. List creation stays fast: name + stock selection; membership is edited afterwards on the
list page through a per-stock editor dialog.

### The V1 membership editor exposes one period

`MembershipEditor` offers **Always eligible** or **one** membership period — `From`, `To`, and a
`Present` checkbox. There is deliberately no "add another period", no timeline and no history
browser: a user building an ordinary watchlist should not have to understand index history to add a
stock, and the default for a newly added member is `FULL`, which needs no date at all. No date is
ever invented to satisfy a constraint; `FULL` is the absence of a restriction, not a range from the
beginning of time.

**`FULL` is shown as "Always eligible", never "Full history".** The mode says nothing about how
much price history the stock has — it says membership places no limit on when it may be bought, so
wording that implies a dataset would describe the wrong thing. `ALWAYS_ELIGIBLE_LABEL` in
`features/lists/utils/buy-windows.ts` is the one place that string lives.

`Present` is the open-ended state. Internally it is `endDate: null` and nothing else — never a
sentinel, a far-future date, or today's date frozen in. The editor keeps `present` as its own flag
rather than treating an empty end input as open-ended, so "I have not filled this in yet" and "this
has no end" stay different states and the form can ask for the first without saving the second. The
row renders it as the word `Present`, in the product's standard day format:
`Nov 30, 1982 → Present`.

### A one-period editor must not destroy a multi-period member

The backend stores any number of periods, and `PUT …/buy-windows` replaces the complete set — so a
naive one-period form would flatten `[p1, p2, p3]` to `[p1]` on any read/edit/save cycle. There are
no built-in or system lists to make read-only, so the protection lives in the editor: an item with
more than one stored period opens **read-only**, listing every period it has, with no form and no
save button. The single-period form appears only after the user presses `Replace with one period`.
The collection row shows the same truth — the first period plus `+N more`, with all of them in the
cell's title — rather than implying continuous eligibility across a gap.

`lists.user.spec.ts` asserts this against a member the API gave two periods: opening the editor,
closing it, and re-reading the API must return both periods unchanged.

## Testing

- Normalization: `packages/domain/src/stock-lists.test.ts`.
- API + ownership + cascades: `apps/api/src/lists/stock-lists.integration.test.ts`
  (`useTestDatabase()`, randomized isolated users and catalog rows — never QA personas).
- UI: `apps/web/src/features/lists/**` component suites.
- E2E: `apps/web/e2e/lists/lists.user.spec.ts` needs the deterministic fictional QA catalog rows
  (`pnpm test:securities:seed`, `QATEST1`/`QATEST2`); it never assumes real market symbols exist.
