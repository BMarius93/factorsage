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

A list belongs to exactly one user, or is **built-in** (`SYSTEM`) content
(`docs/decisions/builtin-dashboard-signals-v1.md`). Reads (`GET /lists`, `GET /lists/:listId`) accept
a Guest, who sees built-ins only; every write requires a session. The service scopes every query: a
list that belongs to someone else answers exactly like one that does not exist (404 with the
identical message), for administrators too, so a leaked list id reveals nothing. A built-in list is
readable by everyone and changeable only by an `ADMIN` — anybody else is refused with `403`
`SYSTEM_CONTENT_READ_ONLY` — and it is never deleted (`409` `SYSTEM_CONTENT_PROTECTED`). Built-ins
are platform content: no plan's symbol limit applies to them, and their `compliance` is always
compliant. A customer sees a built-in list read-only; an administrator gets the ordinary editor
without a delete action. The browser UI is presentation only — the API/service layer is the
authorization authority.

### The maintained point-in-time universe

One built-in list is not edited by anybody: **S&P 500 — Historical PIT** (`systemKey`
`sp500-historical-pit`, `docs/decisions/sp500-historical-pit-v1.md`). It is a projection of the
canonical index membership — every security that was an S&P 500 constituent since 1996, each with
CUSTOM buy windows exactly as long as its memberships — rewritten whole by
`pnpm data:index-universe -- project`. `canEdit` is `false` for every caller, administrators
included, and every List write answers `403` `SYSTEM_CONTENT_READ_ONLY` (the
`SystemContentMaintainedError`). Its summary and detail carry a `universe` object: the distinct
securities, the most members it held on one date, the current members, the membership floor and
when the membership was last synchronized. Duplicating it gives an ordinary list held to the
ordinary limits (734 members exceed every plan's 100-stock limit, so the copy is refused for
customers).

### Duplicating a list

A signed-in user may **duplicate** any list they can read — their own or a built-in
(`POST /lists/:listId/duplicate`, from the collection row's `…` menu only). The copy is an
ordinary `USER` list owned by the caller: the source's description, its members in their order and
every member's buy-window mode and canonical ranges, all under new ids. Nothing built-in carries
over (`systemKey`, `displayOrder`, `updatedByUserId`), nothing historical is copied (backtest runs
and Monitors keep referencing the source), and the source is only read. What the copy does record
is its **origin**: `COPIED`, and — when the chain of copies starts at a built-in — that built-in's
`systemKey` and a digest of its membership as copied, which is how a shared backtest later tells an
unchanged copy from a derived one (`docs/decisions/canonical-definitions-v1.md` §5). A list created
from scratch records `AUTHORED`. Only the name comes from
the request, validated exactly like a new list's; names are not unique, so no numbering is needed.
The copy is a new custom list, so `POST /lists`' entitlement checks apply to its size — a built-in
is exempt from the symbol limit, a customer's copy of one is not. Source read and copy write are one
`REPEATABLE READ` transaction, so a concurrent membership edit can never hand the copy a
half-written configuration and a failure leaves nothing behind.

## Buy windows

> A Buy Window represents the period during which a List member is eligible for new BUY actions.
> It may correspond to point-in-time index membership. It does not constrain SELL actions for
> existing positions.

That paragraph is the definition; everything below is how it is enforced. Each list item
independently restricts when a strategy/backtest may open a **new BUY** in that stock. Selling is
never restricted. A Monitor reads the same periods differently — only the **ongoing** one counts,
and it gates every level (§ Membership under a Monitor).

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

### Membership under a Monitor

A backtest asks "was this stock a member on that past date?" over every period it ever had. A
Monitor asks a different question — "is this stock a member **now**?" — and the answer is its
**ongoing** membership only (`docs/decisions/monitor-eod-v2.md` §4):

| Membership | Monitored? |
| --- | --- |
| `FULL` ("Always eligible") | yes |
| `CUSTOM` with an open-ended period (`Present`) that has begun | yes, from that period's start |
| `CUSTOM` with an open-ended period starting later | not yet |
| `CUSTOM` with bounded periods only — even one ending in the future | no |

`Present` is an open-ended meaning, not a comparison with today: a period ending in 2030 is not a
current membership. Earlier closed periods stay stored and play no part.

The rule gates the **whole Strategy** — BUY, SELL and FINAL EXIT alike: a stock that is not a
current member produces no Signal of any kind, and sessions before its ongoing period began are not
part of its Monitor history. When an edit makes a member stop being current, its active Signals end
with the administrative reason "no longer a current list member" (`MEMBERSHIP_CHANGED`) — never as
if its conditions had ended. When an edit changes which period is ongoing (a re-entry after a gap,
a moved start), its state is ended the same way and rebuilt from the new period.

`isOngoingListMember` in `@intrinsic/domain` is the Monitor's predicate; `isBuyWindowEligible` stays
the backtest's, and neither consumer calls the other's. Membership ending is still not a
liquidation event, and there is no forced exit anywhere in the product.

Do not ship a historical index-membership dataset, and do not derive membership from anything but
the periods a user stored.

## Mutability and the backtest reproducibility invariant

A `StockList` is mutable configuration. **A completed or running backtest must never depend on the
current state of a list.** A backtest snapshots the selected universe and each member's buy-window
configuration at submission time, so editing or deleting a list later cannot retroactively change
historical results (`backtests.md`). A Monitor is the deliberate opposite: it snapshots nothing and
reads the list's current membership and periods at the start of every scan cycle, so an edit is
watched from the next cycle on and a removed member's active Signals are resolved by that cycle
(`monitors.md`, "Lifecycle in one place"). The two consumers of a list therefore answer "which
universe?" differently, and both on purpose.

## API surface

Writes require the session cookie and the two reads accept a Guest (built-ins only); bodies are parsed by `stock-list-requests.ts` against the
shared limits in `@intrinsic/contracts` (`stock-lists.ts`).

```text
GET    /lists                                   summaries with item counts
POST   /lists                                   create; optional initial securityIds (atomic)
GET    /lists/:listId                           detail with items + buy windows
PATCH  /lists/:listId                           rename / update or clear description
DELETE /lists/:listId                           delete with cascades
POST   /lists/:listId/duplicate                 copy an own or built-in list into a new own list -> detail
POST   /lists/:listId/items                     idempotent batch add by securityIds -> detail
DELETE /lists/:listId/items/:itemId             remove one membership
PUT    /lists/:listId/items/:itemId/buy-windows replace complete configuration -> canonical item
```

Structured events (`component: stock-lists`, `actorUserId` from the request context):
`stock-list.created/updated/deleted/duplicated`, `stock-list.items.added`, `stock-list.item.removed`,
`stock-list.buy-windows.updated`.

## Frontend

`apps/web/src/features/lists/` with routes `/lists` and `/lists/[id]`. The membership picker
(`SecurityMultiSelect`) is the `multi` mode of the shared stock combobox (`useSecurityCombobox`,
see `ai/architecture/ui-system.md`) that also drives the topbar search — one search behavior,
catalog-only, recently viewed stocks on a blank field, the same throttling copy, and Enter can only
select a real result, never free text. List creation stays fast: name + stock selection; membership is edited afterwards on the
list page through a per-stock editor dialog. From ten members the list page offers a search by ticker
or company and a Sort (list order, ticker, company). The members page 25 at a time (10, 25, 50 or
100), and a list whose membership is dated — the point-in-time universe, or members with their own
periods — offers **Current members** (a strategy may buy them today), **Former members** (every
period has ended) and **All members** (the default; a member whose first period has not begun is
only here). After stocks are added, the page shows them: a filter or search that would hide them
gives way, the page that holds them opens, and their rows are tinted for a moment (see
`useCollection` in `ai/architecture/ui-system.md`).

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
naive one-period form would flatten `[p1, p2, p3]` to `[p1]` on any read/edit/save cycle. The protection lives in the editor: an item with
more than one stored period opens **read-only**, listing every period it has, with no form and no
save button. The single-period form appears only after the user presses `Replace with one period`.
The member row answers "is it a member **today**?" first, by meaning rather than storage order
(UI-019): "Member now · since Sep 19, 2025" (or "· until …" for a bounded current period), "Joins
Jan 4, 2027" when only a future period remains, "Ended Jun 29, 2018" when every period is over.
Periods are stored oldest first, so leading with the first one showed a stock that rejoined an
index as if it were ineligible. Every period is listed behind a native "N periods" disclosure that
opens by touch and keyboard — never only in a tooltip — so a gap is never presented as continuous
eligibility. Nothing about writing or normalising periods changes.

`lists.user.spec.ts` asserts this against a member the API gave two periods: opening the editor,
closing it, and re-reading the API must return both periods unchanged.

## Testing

- Normalization: `packages/domain/src/stock-lists.test.ts`.
- API + ownership + cascades: `apps/api/src/lists/stock-lists.integration.test.ts`
  (`useTestDatabase()`, randomized isolated users and catalog rows — never QA personas);
  duplication in `stock-lists.duplicate.integration.test.ts`, and `e2e/lists/duplicate.user.spec.ts`
  in the browser.
- UI: `apps/web/src/features/lists/**` component suites.
- E2E: `apps/web/e2e/lists/lists.user.spec.ts` needs the deterministic fictional QA catalog rows
  (`pnpm test:securities:seed`, `QATEST1`/`QATEST2`); it never assumes real market symbols exist.
