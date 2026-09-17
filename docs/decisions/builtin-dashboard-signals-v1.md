# Built-in Dashboard Signals V1

## Status

**Accepted product/implementation specification.**

This decision defines the V1 public Dashboard signal feed, built-in Lists/Strategies/Monitors,
admin ownership/editing, signal lifecycle/history, guest behaviour, and the seed/bootstrap path.

It is intentionally implementation-oriented so a coding agent can execute the work without
re-opening product questions.

## Why this exists

A first-time visitor must land on a Dashboard that already demonstrates the product:

- real current Strategy matches;
- both persistent matches and trigger-based setups/events;
- Lists whose historical BUY eligibility changes over time;
- the same List + Strategy primitives the Backtest engine already uses;
- no fake/demo-only signal path.

The Dashboard is intentionally simple: **a table of current matches/setups from enabled Monitors**.
It is not an analytics dashboard.

---

## 1. Product model

The product keeps the existing canonical concepts:

```text
StockList + Strategy -> Monitor -> current monitor state -> durable Signal occurrences
```

Built-ins are first-class domain objects. They use the same List, Strategy, Monitor, evaluator,
stock data, calculated series, Buy Window, and Backtest semantics as user-created objects.

There is no separate demo evaluator, demo signal table, or hard-coded Dashboard result set.

### Built-in counts

V1 ships exactly:

- **3 built-in Lists**, exactly 10 securities each;
- **2 built-in Strategies**;
- **3 built-in Monitors**;
- one Monitor per List;
- Strategy A used by one Monitor;
- Strategy B reused by the other two Monitors.

All three built-in Monitors are visible/enabled by default for a Guest and a newly registered user.

---

## 2. Signal lifecycle

The current Monitor product documentation treats every trigger-bearing signal as a one-session
trigger event. **This decision changes that behaviour.** The implementation must update
`ai/product/monitors.md`, `ai/architecture/monitor-engine.md`, `ai/architecture/deep-discovery.md`,
`ai/README.md`, tests, and code so the canonical documentation and implementation agree.

### 2.1 States

The durable current state of one evaluated Strategy signal is:

```text
INACTIVE
PENDING_TRIGGER
ACTIVE
RESOLVED
```

`NOT_EVALUABLE` is an evaluation result, not a lifecycle state. A not-evaluable observation does
not invent a state transition and does not synthesize an observation date.

### 2.2 Conditions only

A Strategy signal with one or more Conditions and no Trigger is a persistent state.

```text
INACTIVE/RESOLVED -- conditions become true --> ACTIVE
ACTIVE             -- conditions stay true ---> ACTIVE
ACTIVE             -- conditions become false -> RESOLVED
```

A later true run creates a **new Signal occurrence**. The previous resolved Signal is never reopened.

### 2.3 Conditions + Trigger

A Trigger controls **entry into ACTIVE**. Once it has fired, it is latched for that Signal occurrence;
the non-trigger Conditions maintain the ACTIVE state.

```text
conditions false
    -> INACTIVE

conditions true, Trigger has not fired for this setup
    -> PENDING_TRIGGER

PENDING_TRIGGER + Trigger fires
    -> ACTIVE

ACTIVE + conditions remain true
    -> ACTIVE

ACTIVE + any required Condition becomes false
    -> RESOLVED
```

Important consequences:

- while ACTIVE, a later false value of the Trigger predicate/event does **not** resolve the Signal;
- while ACTIVE, another crossing does **not** emit a second Signal;
- `PENDING_TRIGGER -> INACTIVE` when the setup breaks before the Trigger fires;
- `PENDING_TRIGGER -> INACTIVE` is not a resolved Signal because no Signal occurrence became ACTIVE;
- after a resolved run, Conditions becoming true again starts a fresh `PENDING_TRIGGER` setup and
  requires a fresh Trigger event before a new Signal occurrence is created.

### 2.4 Trigger only

A Strategy signal with zero Conditions and one Trigger is an event.

```text
INACTIVE/RESOLVED -- Trigger fires --> ACTIVE
ACTIVE -- next real eligible exchange-session observation --> RESOLVED
```

The Signal remains ACTIVE for the **exchange observation/session date in which it fired**.
It does not resolve because the wall clock reached midnight and it does not resolve on another scan
of the same session. A Friday event remains active through a weekend and resolves when a later real
session is observed.

### 2.5 Buy-window interaction

Canonical List BUY eligibility continues to gate **BUY only**.

For BUY levels:

- an ineligible observation may not enter `PENDING_TRIGGER`;
- an ineligible observation may not create a new ACTIVE Signal;
- if a currently ACTIVE BUY Signal crosses out of its eligible Buy Window, resolve it with a
  buy-window reason;
- if a PENDING_TRIGGER setup crosses out of eligibility, return it to INACTIVE without creating a
  resolved Signal occurrence.

SELL and FINAL EXIT are not gated by Buy Windows.

### 2.6 Strategy/List edits and rebinds

Keep the existing correctness rules:

- a logic change closes current Signal occurrences for the changed logical identity and resets its
  transition state;
- removing a List member closes its current Signals on the next cycle;
- re-binding a Monitor to a different Strategy or List is a configuration boundary: resolve active
  Signals, discard transition state, clear `lastScanAt`, keep history;
- retry/restart/re-observation of the same input must not duplicate a Signal or transition.

### 2.7 FINAL EXIT OR rules

User-facing FINAL EXIT remains one level and one Signal occurrence even though it may have multiple
OR Exit Rules.

Implementation must preserve enough internal state to apply the lifecycle above correctly per Exit
Rule and then OR the rule results into the single FINAL EXIT level result. If the current single
level-state row cannot distinguish multiple trigger/setup lifecycles, introduce rule-local internal
state rather than weakening the semantics.

Several Exit Rules matching on one observation still produce **one** FINAL EXIT Signal occurrence.

---

## 3. Durable current state, Signal occurrences, and transition history

Do not derive the current Dashboard state by scanning Signal history.

### 3.1 Current state

Keep/extend the durable Monitor state row as the fast current truth for an evaluated unit. It must
carry enough data for correct retries and trigger semantics, including at minimum:

- Monitor identity;
- Security identity;
- Strategy level identity (and Exit Rule identity internally when necessary);
- canonical logic fingerprint;
- current lifecycle state;
- observation/session date last decided;
- last evaluated timestamp;
- trigger/arming state required to distinguish a genuine edge;
- current active Signal id when one exists.

### 3.2 Signal occurrence

A durable `Signal` row is created only when a unit enters `ACTIVE`.

A Signal occurrence is append-only identity:

```text
monitorId
securityId
levelId / kind
logic fingerprint
activatedAt
activatedObservationDate
observed price / canonical output already required by Monitor
resolvedAt nullable
resolvedObservationDate nullable
resolutionReason nullable
```

A later reactivation creates another Signal row. Never reopen a resolved row.

### 3.3 Transition history

Persist lifecycle transitions for audit/history. A transition history row must be addressable before
an ACTIVE Signal exists, because `INACTIVE -> PENDING_TRIGGER` happens before Signal creation.
Therefore transition history is keyed to Monitor/Security/logical identity, with `signalId` nullable.

Persist only **state changes**, not every scan:

```text
INACTIVE -> PENDING_TRIGGER
PENDING_TRIGGER -> ACTIVE
ACTIVE -> RESOLVED
PENDING_TRIGGER -> INACTIVE
RESOLVED -> PENDING_TRIGGER
RESOLVED -> ACTIVE
```

Suggested fields:

```text
monitorId
securityId
levelId
exitRuleId nullable
logicFingerprint
fromState
toState
occurredAt
observationDate nullable
reason
signalId nullable
```

`lastEvaluatedAt` belongs on current state/Monitor status; do not write repetitive `ACTIVE -> ACTIVE`
audit rows.

---

## 4. Dashboard

### 4.1 Purpose

Dashboard V1 is a **table of all current Monitor matches/setups visible to the viewer**.

Primary rows are:

- `ACTIVE` Signals;
- `PENDING_TRIGGER` setups.

Do not show `INACTIVE` or `RESOLVED` in the main Dashboard table. Resolved history is a separate
future/history surface.

### 4.2 One row per Monitor outcome

Do **not** deduplicate the same Security across Monitors in V1.

If AAPL matches two Monitors, show two rows because they are two independent Strategy/List outcomes:

```text
AAPL | BUY | ACTIVE | Monitor A
AAPL | BUY | ACTIVE | Monitor B
```

### 4.3 Required row information

Desktop table should expose at least:

- Security identity/logo + symbol;
- action/level (`BUY`, `SELL`, `FINAL EXIT`);
- state (`ACTIVE` or user-facing `Waiting for trigger`);
- human-readable reason from the canonical Strategy description functions;
- Monitor;
- Strategy;
- List;
- current/observed price;
- activated/setup time/date as appropriate;
- relevant metric value when the existing contracts expose it without a parallel calculation.

Keep V1 visual language/parity: desktop table, mobile record cards, row click to Stock Details.
Links inside a row may navigate to Monitor/Strategy/List without changing row-click behaviour.

### 4.4 Filters/sort

V1 should support simple filtering for:

- All;
- Active;
- Waiting for trigger;
- optionally BUY / SELL / FINAL EXIT if that fits the existing table/filter primitives cleanly.

Default ordering: newest state activation/setup transition first, then stable deterministic tie-breakers.

### 4.5 Freshness

Show Monitor/Dashboard freshness using actual scan timestamps. Never call data real-time when the
last successful scan is stale. `NOT_EVALUABLE` does not fabricate freshness.

---

## 5. Guest, signed-in user, and Monitor toggles

### 5.1 Guest

A Guest has no persisted preference rows.

The three published built-in Monitors are treated as enabled by default and their current results are
visible on the Dashboard.

The toggle control may be visible, but attempting to change a built-in Monitor preference must ask
the visitor to sign in; do not create anonymous persistence.

### 5.2 Signed-in users

A signed-in user gets all published built-in Monitors enabled by default unless a preference row says
otherwise.

Do **not** clone three system Monitors per user.

Persist only the override, e.g.:

```text
UserBuiltInMonitorPreference
  userId
  monitorId
  enabled
  unique(userId, monitorId)
```

Absence of a row means the built-in default (`enabled = true`).

Changing this preference affects **visibility for that user**, not whether the shared system Monitor
is evaluated.

### 5.3 User-owned Monitors

User-created Monitors continue to use their real `Monitor.enabled` lifecycle. A disabled user Monitor
is excluded from the Dashboard even if its persisted Signals remain active/frozen according to
canonical Monitor disable semantics.

### 5.4 Global system state

A built-in Monitor also needs an operator/global publication switch, separate from a user's
preference:

```text
isPublished
isGloballyEnabled
```

- `isPublished=false`: not visible/selectable to customers;
- `isGloballyEnabled=false`: worker does not evaluate it;
- user preference never changes these fields.

---

## 6. SYSTEM ownership and admin editing

Built-ins are **SYSTEM-owned**, not owned by a special fake customer account.

Reuse the existing `USER | ADMIN` authorization model. Do not add a `MASTER` role.

The schema may implement system ownership with an explicit ownership discriminator or equivalent
nullable-owner invariant, but it must provide these stable properties:

```text
ownership = USER | SYSTEM
ownerUserId = null for SYSTEM
systemKey = stable immutable key for SYSTEM objects
```

`systemKey`, not display name, is the seed/update identity.

Examples:

```text
list:     sp500-growth-leaders
strategy: value-and-trend
monitor:  sp500-value-and-trend
```

An ADMIN may edit SYSTEM Lists, Strategies, and Monitors using the existing editors/components as far
as practical. Normal users may read/use built-ins but cannot mutate them.

Admin editing includes:

- name;
- description;
- List members and Buy Windows;
- Strategy definition;
- Monitor name/binding;
- `isPublished` / global enabled state;
- optional display order.

Keep normal Strategy versioning. Editing a built-in Strategy appends a StrategyVersion just like a
user Strategy.

A production admin account is a normal authenticated User with `role=ADMIN`; credentials/passwords
must never be hard-coded in source control. Existing QA `ADMIN_USER` remains a test persona, not the
production ownership mechanism.

---

## 7. Seed/bootstrap behaviour

### 7.1 Idempotent bootstrap

Ship a dedicated idempotent built-in bootstrap/seed command.

The normal production bootstrap must be **create-if-missing by `systemKey`**. It must not overwrite
operator edits on every deploy.

A separate explicit development/reset command may restore canonical built-in defaults.

Never identify a built-in by display name.

### 7.2 Security lookup

Seed Lists by resolving existing canonical `Security` rows. Do not create free-text/list-local
security identities.

If a required Security is missing, fail loudly with the missing symbol(s) and instruct the operator
to run the normal security-catalog sync first.

### 7.3 Historical bootstrap for Monitor state

After creating a built-in Monitor, bootstrap enough historical observation state that trigger logic
starts correctly. A fresh deployment must not pretend every trigger-bearing setup has no prior
history simply because the Monitor row was created today.

The bootstrap/replay path must:

- use the same canonical evaluator/series semantics as normal monitoring/backtest;
- establish previous-observation state for triggers;
- establish the correct current `INACTIVE` / `PENDING_TRIGGER` / `ACTIVE` state;
- avoid fabricating customer-visible duplicate Signal history from every replayed historical day;
- be deterministic and idempotent.

Prefer a dedicated bootstrap/reconstruction mode rather than special-casing the live scan loop.

---

## 8. Built-in Lists

Every List has exactly 10 securities.

The dates below are V1 seed data. Before committing the final seed, verify every historical date
against an authoritative exchange/index/company source and record the source in a seed-data comment
or development doc. Do not silently change the product selection while implementing.

### 8.1 `S&P 500 Growth Leaders`

`systemKey = sp500-growth-leaders`

Description:

> A curated set of large-cap growth companies in the S&P 500. Long-standing members are always eligible; recent additions become eligible from their S&P 500 inclusion date.

| Symbol | BUY eligibility |
| --- | --- |
| AAPL | Always eligible |
| MSFT | Always eligible |
| NVDA | Always eligible |
| AMD | Always eligible |
| META | Always eligible |
| PANW | 2023-06-20 -> Present |
| ABNB | 2023-09-18 -> Present |
| UBER | 2023-12-18 -> Present |
| CRWD | 2024-06-24 -> Present |
| PLTR | 2024-09-23 -> Present |

Intent: a five-year backtest has a useful starting universe immediately, then visibly gains members
as historical S&P inclusion windows begin.

### 8.2 `Nasdaq-100 Newcomers`

`systemKey = nasdaq100-newcomers`

Description:

> Selected Nasdaq-100 additions from recent reconstitutions. Each company becomes buy-eligible from its Nasdaq-100 inclusion date.

| Symbol | BUY eligibility |
| --- | --- |
| HON | 2021-07-21 -> Present |
| FTNT | 2021-12-20 -> Present |
| DDOG | 2021-12-20 -> Present |
| ODFL | 2022-01-24 -> Present |
| FANG | 2022-12-19 -> Present |
| ROP | 2023-12-18 -> Present |
| AXON | 2024-12-23 -> Present |
| MSTR | 2024-12-23 -> Present |
| MPWR | 2025-12-22 -> Present |
| WDC | 2025-12-22 -> Present |

If authoritative verification shows one of these securities subsequently left the Nasdaq-100 before
V1 launch, do **not** keep an open-ended period under a false description. Either encode the actual
end/re-entry history using the backend's canonical multi-period representation or substitute a
currently eligible selection while preserving the intended year distribution. Record the change in
the implementation PR.

### 8.3 `Recent Market Debuts`

`systemKey = recent-market-debuts`

Description:

> Ten notable public-market debuts since 2021. Each company becomes buy-eligible from its first public trading day.

| Symbol | BUY eligibility |
| --- | --- |
| HOOD | 2021-07-29 -> Present |
| RIVN | 2021-11-10 -> Present |
| MBLY | 2022-10-26 -> Present |
| CAVA | 2023-06-15 -> Present |
| ARM | 2023-09-14 -> Present |
| ALAB | 2024-03-20 -> Present |
| RDDT | 2024-03-21 -> Present |
| CRWV | 2025-03-28 -> Present |
| CRCL | 2025-06-05 -> Present |
| FIG | 2025-07-31 -> Present |

Intent: demonstrate the most intuitive Buy Window case — a stock cannot be bought before its public
trading debut — while still giving a five-year backtest members from the first year.

---

## 9. Built-in Strategies

Use only metrics/operators currently supported by the canonical Strategy Builder registry.
Do not add a metric solely for these built-ins.

Thresholds are accepted V1 defaults, but the implementation may tune only the numeric thresholds
slightly **after** running the required calibration described in section 12. Any changed threshold
must be documented in the PR with before/after Dashboard counts and five-year backtest evidence.
Do not change the conceptual rules.

### 9.1 Strategy A — `Value & Trend`

`systemKey = value-and-trend`

Description:

> Looks for discounted stocks in a healthy long-term trend, trims when valuation becomes stretched, and exits when the long-term trend breaks.

#### BUY 100%

Conditions only:

```text
Margin of Safety (Balanced) is above 5%
AND
Price is above SMA 200D
```

No Trigger.

#### SELL 50%

Conditions only:

```text
Margin of Safety (Balanced) is below -15%
AND
Price is above SMA 200D
```

No Trigger.

#### FINAL EXIT

One condition-only Exit Rule:

```text
Price is below SMA 200D
```

This Strategy intentionally creates persistent ACTIVE Dashboard rows.

### 9.2 Strategy B — `Trend Confirmation`

`systemKey = trend-confirmation`

Description:

> Waits for short-term momentum to recover inside an established long-term uptrend, and exits when price breaks below its 200-day average.

#### BUY 100%

Conditions:

```text
SMA 50D is above SMA 200D
AND
Price is above SMA 200D
```

Trigger:

```text
Price crosses above SMA 20D
```

This is the canonical V1 demonstration of `PENDING_TRIGGER -> ACTIVE` with Conditions maintaining
ACTIVE after the Trigger fires.

#### FINAL EXIT

One trigger-only Exit Rule:

```text
Price crosses below SMA 200D
```

This intentionally demonstrates the one-session trigger-only lifecycle.

No SELL level is required for this Strategy in V1.

---

## 10. Built-in Monitors

### 10.1 `S&P Value & Trend`

```text
systemKey = sp500-value-and-trend
List       = S&P 500 Growth Leaders
Strategy   = Value & Trend
```

### 10.2 `Nasdaq Trend Confirmation`

```text
systemKey = nasdaq-trend-confirmation
List       = Nasdaq-100 Newcomers
Strategy   = Trend Confirmation
```

### 10.3 `New Listings Trend Confirmation`

```text
systemKey = new-listings-trend-confirmation
List       = Recent Market Debuts
Strategy   = Trend Confirmation
```

All three ship published and globally enabled.

---

## 11. Backtest integration

Built-in Lists and Strategies must be selectable anywhere the user's plan is allowed to select a
List/Strategy for a Backtest.

They do not count against user-created List/Strategy quantity limits. Their 10 securities are the
actual List members and their Buy Windows are canonical BUY eligibility — not a Dashboard-only
filter.

A Backtest using a built-in combination uses the exact same snapshot/freeze rules as a user-owned
combination. Once a run starts, later ADMIN edits to a built-in must not alter the completed run's
meaning.

Primary product flow to preserve:

```text
Dashboard current match
    -> inspect Stock / Monitor / Strategy / List
    -> run a five-year Backtest over the same built-in Strategy + List
```

---

## 12. Calibration requirement

The built-ins are product onboarding, so they must generate a useful live Dashboard without faking
matches.

Before considering the implementation complete, run the three built-in Monitor combinations over
real current data and the two Strategy/List combinations through five-year Backtests.

Target experience, not a hard invariant:

- several current ACTIVE rows across the three Monitors;
- several `PENDING_TRIGGER` rows from Trend Confirmation when market state permits;
- not all 30 securities matching at once;
- five-year Backtests contain meaningful activity rather than near-zero trades;
- intrinsic-value unavailability is measured for Strategy A's securities rather than silently
  treated as false/zero/future-known data.

If `5%` / `-15%` makes Strategy A nearly empty or nearly universal, tune those **numeric values only**
and record evidence. If Strategy B is too sparse, tune only the short-term trigger threshold/series
within the existing conceptual design and record evidence; do not remove the trigger merely to fill
the Dashboard.

No code may create synthetic Signals to satisfy the target counts.

---

## 13. Admin surface

Provide an ADMIN-only entry point that can manage the three SYSTEM object types.

Prefer reuse of existing List/Strategy/Monitor editors rather than a parallel CMS.

Minimum acceptance:

- USER receives 403 / no mutation controls for SYSTEM objects;
- ADMIN can edit name/description and canonical definitions/membership;
- ADMIN can publish/unpublish and globally enable/disable a built-in Monitor;
- changing display names does not change `systemKey`;
- deploy/bootstrap does not overwrite ADMIN edits;
- normal audit fields include `updatedAt` and, where practical, `updatedByUserId` for SYSTEM edits.

---

## 14. API/contracts

Add explicit contracts for the Dashboard instead of having the web join several unrelated endpoints.

The server should return a normalized Dashboard row/read model that can represent both:

- an ACTIVE durable Signal occurrence;
- a PENDING_TRIGGER current state with no Signal occurrence yet.

Do not expose persistence internals such as fingerprints merely because the UI needs a status.

The Dashboard endpoint must support Guest reads and authenticated reads. Authentication changes only
visibility/preferences, not the canonical Signal calculation.

Any new routes must be documented in `docs/openapi.yaml` and covered by the OpenAPI contract test.

---

## 15. Entitlements

Built-in visibility is not a paid entitlement by itself.

V1 expectations:

- Guest can see current built-in Dashboard rows;
- Free can see them and persist built-in Monitor visibility toggles;
- built-in Lists/Strategies do not consume user-owned object count limits;
- Backtest execution continues to use the existing plan gates (historical depth, concurrency,
  symbol cap, custom-object policy, etc.); do not duplicate plan comparisons in Dashboard code.

Read `docs/decisions/entitlements-v1.md` before implementing any gate.

---

## 16. Test/validation acceptance

At minimum add coverage for:

### State machine

- conditions-only false -> true -> true -> false creates one Signal then resolves it;
- conditions + trigger: conditions true creates PENDING_TRIGGER, crossing creates one Signal,
  trigger predicate later false does not resolve while Conditions stay true;
- conditions + trigger resolves when a Condition becomes false;
- pending setup breaking before trigger returns to INACTIVE and never creates a Signal;
- after resolution, a fresh setup requires a fresh trigger;
- trigger-only stays ACTIVE for the firing observation date and resolves only on the next real
  observed exchange session;
- weekend/holiday/no-current-observation does not resolve trigger-only;
- retries/restarts/re-observation do not duplicate Signal or transition history;
- Buy Window eligibility gates BUY PENDING/ACTIVE but never SELL/FINAL EXIT;
- FINAL EXIT OR emits one level Signal even if multiple Exit Rules match.

### History

- transition history contains only state changes;
- PENDING transitions are representable before a Signal id exists;
- resolved Signal rows are never reopened;
- Strategy/List edits/rebinds record correct closure reasons and preserve history.

### Built-ins/admin

- bootstrap is idempotent by `systemKey`;
- normal bootstrap does not overwrite edited built-ins;
- USER cannot mutate SYSTEM objects;
- ADMIN can mutate them;
- built-ins do not consume customer object limits;
- Guest sees default built-ins with no preference rows;
- authenticated preference override changes Dashboard visibility only, not shared Monitor evaluation.

### Dashboard

- ACTIVE and PENDING_TRIGGER rows render;
- RESOLVED/INACTIVE do not render in current table;
- same Security from two Monitors renders as two rows;
- desktop table and phone cards both work;
- row click reaches Stock Details;
- monitor toggles require sign-in for Guest and persist for authenticated users;
- stale scan timestamps are presented honestly.

### Backtests

- the built-in List Buy Windows affect BUY eligibility in historical runs;
- completed run snapshot is unaffected by later ADMIN built-in edits;
- five-year smoke runs succeed for all intended built-in combinations.

Run the repository's full validation gate in `ai/workflows/validation.md`, not only feature tests.

---

## 17. Non-goals

Do not add in this slice:

- per-user Monitor cadence;
- a portfolio/position tracker to Monitor;
- synthetic demo Signals;
- per-user clones of built-in objects;
- a second Strategy language;
- additional technical indicators solely to make the Dashboard busier;
- resolved Signal history UI beyond what is necessary for correctness/admin verification;
- paid alert channels/email/push notifications;
- a new `MASTER` authorization role.

---

## 17a. Accepted amendment — built-in content UX (2026-09-17)

The slice shipped as specified above. Using it showed three places where the specification's own
goal — a visitor meeting real product content immediately — was undermined by where that content
was put. The following supersede the sections named, and nothing else in this document changes. No
signal-lifecycle, ownership, entitlement or evaluation semantics move.

**Guest access is navigational, not just deep-linkable (supersedes section 5.1 in part).** The
Lists, Strategies and Monitors **collection** pages are readable without a session and show the
built-in sections. Previously only a detail page whose id the visitor already had was reachable,
which made public built-ins undiscoverable. `GET /monitors` therefore accepts a Guest and returns
published built-ins, as `GET /lists` and `GET /strategies` already did. A Guest still sees no
"Your …" section, and another customer's private object is still `404`.

**A refused action asks, it does not redirect (supersedes section 5.1's "must ask the visitor to
sign in").** Every protected action — New list / strategy / monitor, and a built-in Monitor's
visibility switch — opens the shared sign-in prompt in place. Navigating a Guest to `/login`
discarded the page they were reading to tell them they needed an account to change it.

**Monitor visibility moves to the Monitors page (supersedes section 4 and section 5.2's placement,
not their semantics).** The toggle is a property of a Monitor, so it lives in the built-in section
of the Monitors collection. The Dashboard is the signal table alone: the monitor cards below it
competed with the signals they configured and made the product's home page read as a settings
screen. The preference itself is unchanged — one `UserBuiltInMonitorPreference` override row, per
user, never touching evaluation — and is now also reported on `GET /monitors` as
`dashboardVisible`.

**Dashboard row information (supersedes section 4.3).** Columns are Stock, Action, Why, Price,
Strategy, List, Monitor. `Strategy`, `List` and `Monitor` are three columns with three links, not
one combined cell. The `Since` column is removed — the activation time was the least-used fact in
the row and the widest — and so is the per-row `Backtest` button, which repeated one call to action
on every row of a table whose job is to report. Row click still opens Stock Details; the phone
presentation is still the shared `DataTable` card.

**Dashboard filters (supersedes section 4.4).** The state filter (All / Active / Waiting) is a
segmented control with counts; the action filter (All actions / Buy / Sell / Final exit) is a
dropdown. They are deliberately different control shapes, because two identical pill groups read as
two competing tab systems rather than one view and one refinement of it. They compose as
state AND action.

**Collections separate ownership (new).** Each collection page shows the viewer's own content
first and built-in content second, in two sections, rather than one mixed table. A signed-in user
with nothing of their own gets a compact empty section, never a full-page empty state that hides
the built-ins below it.

## 18. Recommended implementation order

1. Update canonical Monitor lifecycle docs/tests for the accepted state machine.
2. Extend durable Monitor state and add transition audit persistence.
3. Make evaluator/worker satisfy the new Conditions+Trigger latch semantics and FINAL EXIT rule-local
   requirements.
4. Add SYSTEM ownership + stable `systemKey` and ADMIN mutation authorization.
5. Add built-in bootstrap/reset tooling and seed the 3 Lists + 2 Strategies + 3 Monitors.
6. Add historical Monitor-state bootstrap/reconstruction.
7. Add per-user built-in Monitor preferences.
8. Add Dashboard API read model.
9. Build Dashboard desktop/mobile UI + toggles.
10. Expose built-in Lists/Strategies to Backtest selection through existing entitlement boundaries.
11. Run real-data calibration, five-year backtest smoke runs, full e2e/validation gate.
12. Update all architecture/product docs and OpenAPI to the final implemented state.

The implementation PR should explicitly call out any deviation from this decision rather than
silently choosing a different product behaviour.
