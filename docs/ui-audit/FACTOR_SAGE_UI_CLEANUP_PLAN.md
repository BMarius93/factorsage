# FactorSage V2 — UI Cleanup Implementation Plan

| Item             | Value                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------- |
| Status           | Proposed execution plan                                                                 |
| Prepared from    | [FactorSage UI/UX Audit](./FACTOR_SAGE_UI_UX_AUDIT.md) and its 642-capture evidence set |
| Reviewed branch  | `UI-audit` at `accf2f38`                                                                |
| Product baseline | `25b0461f`                                                                              |
| Date             | 2026-09-19                                                                              |
| Audience         | Engineers and designers planning the cleanup, including people new to FactorSage        |

---

## 1. Recommendation in one sentence

Do **not** redesign FactorSage. Preserve the existing visual identity and converge the remaining
screens onto the product's already-good shared system, fixing trust, containment and workflow
problems before doing broad visual polish.

The audit is credible and unusually well evidenced. Its strongest conclusion is correct: FactorSage
is not a collection of unrelated pages; it is one mostly coherent system with a few local dialects
and several shared primitives that do not yet enforce their own contracts.

The cleanup should therefore proceed in this order:

1. fix shared containment and unreachable feedback;
2. make billing, entitlement and failure states truthful;
3. stop the Strategy Builder and membership UI from misrepresenting product state;
4. restore the core List → Strategy → Backtest → Monitor workflow;
5. improve signal freshness and dense-data navigation;
6. consolidate styles and low-risk polish.

The 13 P1 findings are release blockers. P2/P3 work should be pulled into a release PR only when it
shares the same root component and materially lowers regression risk. Do not turn the launch gate
into a general rewrite.

---

## 2. Independent assessment of the audit

### 2.1 What the evidence confirms

Direct review of the report, manifest, code-level UI rules and representative captures confirms the
following root causes:

- `EntityReferenceChip` clips its visible label but does not reliably constrain its intrinsic size
  inside every flex/grid/table context. This is the common cause behind the desktop table blow-out
  and the phone Dashboard overflow.
- The mobile `DataTable` composition puts maintenance actions in the wrong card region, while
  `OverflowMenu` assumes that right-alignment is always safe. That combination clips the menu.
- plan limits are enforced correctly by the API but presented too late by the web app;
- several failure and billing states display statements that are factually false for the state
  underneath them;
- the Strategy Builder's defaults are product behaviour, not merely styling: adding a row authors a
  real rule the user did not choose;
- current membership, signal age and effective monitor state exist in data but are either hidden or
  rendered in a misleading order;
- the shared visual foundation is sound: palette, typography family, flat surfaces, data density,
  table-to-card model, shell and result-page hierarchy should remain.

### 2.2 Recommendations that should be adjusted rather than copied literally

| Audit suggestion                                                          | Decision for implementation                                                                                                        | Reason                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Return to documented 768/1,024 px breakpoints                             | **Keep 880 px as the canonical dense/compact switch and correct the docs.**                                                        | The shell, bottom nav, tables and workflow footer already agree at 880 px. Moving all of them creates risk without a product benefit.                                            |
| Keep one stretched card per row up to 879 px                              | **Use a fluid one/two-column card grid below 880 px.**                                                                             | A 390 px phone still gets one column; an ~800 px content area can fit two readable ~380 px cards without inventing another hard breakpoint.                                      |
| Put “Run backtest” on every row and every entity, including Stock Details | **Put it in List, Strategy and Monitor detail headers; keep collection rows focused on Open. Add “Add to list” on Stock Details.** | Row-click plus Open is the stable collection contract. A stock alone is not a valid Backtest configuration; inventing an implicit one-stock list would change the product model. |
| Show four KPI columns at 390 px                                           | **Keep two at small-phone width; use four once space permits. Update the outdated spec.**                                          | Values such as `$137,426.91` are not readable in a ~90 px cell. Extra height is preferable to clipped financial data.                                                            |
| Replace native date controls for visual consistency                       | **Keep native date inputs; standardise only rendered date text.**                                                                  | Native date inputs provide platform accessibility and locale-aware entry. Their OS formatting is not a defect.                                                                   |
| Merge Stock Details fully into generic cards                              | **Converge header, facts, status and error primitives; retain feature-specific chart/valuation composition.**                      | A chart and a valuation panel are domain concepts, not generic section markup. Shared primitives should not absorb stock semantics.                                              |
| Remove the separate “Your” and “Built-in” sections                        | **Keep both ownership sections, align their column templates and remove redundant row badges.**                                    | Ownership is meaningful and affects actions. The current architecture docs conflict and should be corrected to allow grouped collections.                                        |
| Eliminate every guest `/auth/me` 401 for console cleanliness              | **Treat the expected 401 as an accepted session-probe result; fix actual hydration warnings.**                                     | Changing a correct authentication boundary only to quiet DevTools is disproportionate. The audit harness may classify the known 401 separately.                                  |
| Use identical button order and weight in every context                    | **Standardise within contexts, not across unlike contexts.**                                                                       | Dialogs use Cancel → primary. Recovery pages may legitimately lead with Try again. The rule should follow intent, not physical uniformity.                                       |

### 2.3 One additional contract drift to fix

The accepted product decision says every Backtest configuration, run and result requires sign-in,
but `GUEST_ENTITLEMENTS.backtests.canViewDemo` is still `true`, with tests asserting it. Nothing
currently consumes the flag, so it does not expose a route, but it contradicts DEC-007 and is a
future regression trap.

Before feature cleanup begins, set it to `false` (or remove it through an explicit contract change)
and update the contract, API and E2E assertions. This is a small correctness PR, not a UI redesign.

---

## 3. Target visual system

### 3.1 Keep these decisions

- near-white canvas, white surfaces and hairline borders;
- Geist as the product typeface;
- restrained blue used primarily as ink/tint, with one solid-blue commit action;
- green/red/amber reserved for financial and operational meaning;
- 16 px page-level radius, no ordinary surface shadow, and the 28 px/shadowed result hero as the
  single exception;
- desktop tables and mobile record cards rendered from one DOM;
- `PageHeader`, `SectionCard`, `DataTable`, `StatusBadge`, `StockIdentity`, `WorkflowFooter` and
  `SignInPrompt` as the shared vocabulary;
- a dense, calm financial-tool feel rather than marketing-page decoration.

### 3.2 Typography contract

Use the existing token scale; do not introduce a new visual scale:

| Role                | Token / rule                                                      |
| ------------------- | ----------------------------------------------------------------- |
| Page title          | `--text-page-title` (17 px compact, 20 px dense)                  |
| Result hero title   | `--text-page-title-hero` only                                     |
| Section title       | `--text-section-title`                                            |
| Body / control copy | `--text-body`                                                     |
| Supporting text     | `--text-secondary`                                                |
| Metadata / labels   | `--text-small` and `--text-label-size`                            |
| Emphasis            | `--weight-emphasis`; do not add a second feature-level bold scale |

Auth, Admin, Stock status and session gates should consume these roles. Feature CSS may own chart
labels or genuinely local ornaments, but not another page-title or button type scale.

Add a lightweight repository policy test: outside `tokens.css` and an explicit allow-list for chart
rendering/ornaments, new literal `font-size: Npx` declarations fail. Migrate existing literals when
their owning surface is touched; do not create a 226-declaration formatting-only PR.

### 3.3 Surface hierarchy

Every page should have at most three visible levels:

1. page identity (`PageHeader`);
2. page section (`SectionCard`);
3. a nested control well only when it has a distinct interaction role.

Consequences:

- no `SectionCard` inside another `SectionCard`;
- remove the duplicate “Logic / Strategy logic” frame;
- keep the Backtest result hero exceptional;
- keep Stock Details' chart and valuation panels, but use shared header, fact and error primitives;
- collection ownership groups may each have a section heading, but they share one column template;
- a “Built-in” badge appears only where built-in and custom records are mixed.

### 3.4 Action hierarchy

| Action kind              | Treatment                       | Examples                           |
| ------------------------ | ------------------------------- | ---------------------------------- |
| Commit / execute         | solid primary                   | Save, Run backtest, Confirm delete |
| Page-level create/edit   | tinted primary ink              | New list, Edit monitor             |
| Contextual navigation    | neutral outline                 | Open, View results, Back to …      |
| Maintenance              | overflow menu                   | Rename, Disable, Delete            |
| Destructive confirmation | danger only inside confirmation | Delete permanently                 |

Rules:

- “New …” stays in the page header in loading, empty, error and populated states;
- dialogs use Cancel then primary, with the existing phone stacking rule;
- a destructive action is not red at rest in the Strategy Builder; use neutral Remove plus undo, or
  confirmation when the removed block contains authored logic;
- accessible action names include their object (`Open Blue chips`, `Edit Value ladder`).

### 3.5 Controls and pickers

Keep two control densities, both already tokenised:

- 44 px default control for forms, dialogs and touch-first surfaces;
- 38 px compact control for dense predicate/editor rows.

Remove the 46 px auth/monitor variant and ad-hoc select heights. Build these primitives rather than a
single universal “picker” abstraction:

- `Select`: native select styling, default/compact sizes and an explicit unavailable option;
- `EntitySelect`: List/Strategy selection, ownership grouping, loading, error and stale-reference
  handling;
- `SecurityCombobox`: one search behaviour with single- and multi-select modes, shared rate-limit
  handling and one ARIA model;
- `SegmentedControl`: one selection treatment for cadence, ranges, percentages and Dashboard
  filters, while preserving the correct radio/pressed semantics for each use.

### 3.6 Tables and responsive cards

`DataTable` remains the only collection renderer, with a stronger contract:

- identity cells have an explicit floor;
- relationship cells are allowed to shrink below max-content size;
- `EntityReferenceChip` constrains itself and every immediate wrapper has `min-width: 0`;
- actions remain visible; low-priority facts fold into a related cell before horizontal scrolling is
  introduced;
- long prose facts use label-above/value-below on cards;
- identity, state and overflow occupy the card's top row;
- action rows remain at the bottom, but the overflow trigger itself stays top-right;
- `OverflowMenu` detects viewport collisions and flips alignment;
- below 880 px, the record body uses a fluid `auto-fit` grid with a readable minimum card width:
  one column on phones, two columns when the available width genuinely supports them;
- at and above 880 px, tables remain dense. Feature-specific intermediate layouts may fold related
  entities into one configuration cell instead of clipping three separate columns.

### 3.7 State presentation

Use three shared patterns:

- `EmptyState`: empty, not found and fetch failure;
- `Notice`: information, warning, success and operational failure;
- `EntitlementNotice`: current usage, limit, consequence and a relevant next action.

A row gets one effective state, not contradictory pills. For example, a downgraded enabled monitor
is `Paused — plan limit`, while its configured intent can be a secondary fact in details.

Never show raw implementation codes in the main UI. Run IDs and codes may live in a collapsed
“Details for support” disclosure.

### 3.8 Dates, freshness and charts

- Use one formatter module for product-rendered date, datetime and relative time.
- Relative time ticks while the page is open and exposes the absolute value in accessible text or a
  reachable disclosure.
- Keep native date inputs.
- Every signal shows when its present state began.
- Replace “Real-time Matches” with “Current matches” for the end-of-day product.
- Use a neutral dashed line for Cash in the Backtest chart; keep Strategy blue and Benchmark a
  distinct neutral tone.
- Persistent chart legends must not depend solely on hover.

---

## 4. Release policy

### 4.1 Release-blocking findings

All P1 findings must be closed or explicitly reclassified by the product owner before release:

`UI-001`, `UI-002`, `UI-005`, `UI-006`, `UI-008`, `UI-013`, `UI-019`, `UI-020`, `UI-021`,
`UI-025`, `UI-031`, `UI-037`, `UI-046`.

The stale guest demo entitlement is also release-scope because it contradicts an accepted decision,
even though no current route reads it.

### 4.2 Release candidate exit criteria

- no document-level horizontal overflow at 375 or 390 px;
- at 1,280 and 1,440 px, one allowed long name cannot hide a collection's contextual actions;
- a submit refusal is visible and announced without manual scrolling;
- no billing or checkout state claims a plan is confirmed when persisted state says otherwise;
- a canceled customer can purchase any offered plan;
- the blank Strategy Builder authors no rule and displays no error before interaction;
- current membership is the period shown first;
- downgraded users can understand what stopped and how to proceed without a hover tooltip;
- failed Backtests show a user-facing cause/action and no fake empty result sections;
- every current signal says when it began;
- all Backtest surfaces and the guest entitlement contract agree that authentication is required;
- the hermetic provider/email/Stripe constraints from the audit remain in place.

### 4.3 Post-release work

P2/P3 work may follow release when it is not already part of a shared-component fix. Deferral must
mean an explicit backlog entry with an owner, not disappearance from the audit.

---

## 5. Sequenced PR plan

Each PR below has one primary concern and should be reviewable independently. “Size” is relative
engineering/review risk, not a time estimate.

### UI-00 — Align the guest Backtest entitlement contract

**Size:** S · **Release:** required · **Dependencies:** none

**Scope**

- change `GUEST_ENTITLEMENTS.backtests.canViewDemo` to `false`, or remove the flag through an
  explicit versioned contract decision;
- update contract, API integration and guest E2E assertions;
- update stale comments that still describe a guest demo.

**Acceptance**

- Guest cannot access configuration, run or result routes;
- the public entitlement response does not advertise demo access;
- the existing sign-in prompt and safe `next` return remain unchanged.

### UI-01 — Shared containment, tablet cards and mobile actions

**Findings:** `UI-001`, `UI-002`, `UI-003`, `UI-006`, `UI-011`, `UI-050`
**Size:** M · **Release:** required · **Dependencies:** none

**Scope**

- fix intrinsic containment in `EntityReferenceChip` and its wrappers;
- add an identity/relationship/action sizing contract to `DataTable`;
- fold Dashboard relationships at intermediate widths;
- use the fluid one/two-column card grid below 880 px;
- move overflow triggers to the card's top-right and make menus collision-aware;
- stack long “Why” text left-aligned;
- give visible row actions entity-specific accessible names.

**Acceptance**

- 120-character entity names at 390, 879, 880, 1,024, 1,280 and 1,440 px;
- zero page overflow; no clipped menu; actions visible without horizontal scrolling at 1,280+
  px;
- full ticker remains visible in the Dashboard identity column;
- keyboard and Escape behaviour of overflow menus remains intact.

### UI-02 — Submit feedback and focus management

**Findings:** `UI-005`
**Size:** S/M · **Release:** required · **Dependencies:** none

**Scope**

- add a submit-error slot to `WorkflowFooter`;
- on client validation, focus the first invalid control;
- on server refusal, announce and surface the message in the sticky footer, with an in-form copy only
  when it adds context;
- preserve user-entered form state.

**Acceptance**

- at 390 px, concurrency/history/refusal feedback is visible immediately after tapping Run;
- screen readers receive the error through an `aria-live` region;
- keyboard focus moves to the first invalid field, not back to the submit button.

### UI-03 — Truthful Backtest progress, failure and follow-up

**Findings:** `UI-031`, `UI-032`, `UI-033`, `UI-034`
**Size:** M · **Release:** required for `UI-031`; remaining scope ships with it · **Dependencies:** UI-02

**Scope**

- map failure categories to user-facing cause and recovery;
- hide chart/KPI/holdings/trade sections for a run that never produced results;
- move run id/code into “Details for support”;
- provide “Edit and run again” using the immutable snapshot as the prefill source;
- add “View progress” for queued/running rows;
- use a neutral dashed Cash series;
- keep two KPI columns on small phones and document the breakpoint for four;
- add snapshot entity ids to summaries only if the API can do so without violating immutability.

**Acceptance**

- data-unavailable failure does not recommend a blind retry;
- rerun starts from the same visible configuration without mutating the original run;
- failed screens contain no “No trades”/“No positions” success-path copy;
- terminal and non-terminal rows both have a meaningful action.

### UI-04 — Billing state truthfulness

**Findings:** `UI-037`, `UI-038`, `UI-039`, `UI-046`, `UI-047`
**Size:** M · **Release:** required · **Dependencies:** none

**Scope**

- treat ended subscription statuses as having no current price;
- offer a normal purchase/resubscribe action on every eligible plan;
- make cancellation-pending copy point to the actual Manage billing path;
- add a third checkout-return state when reconciliation is still pending;
- do not show confirmation until persisted plan/subscription state confirms it;
- add stocks-per-backtest and precise period-length wording to plan cards;
- standardise on “Plan and billing” (or one product-owner-approved label).

**Acceptance**

- cover Free, active, past due, incomplete, cancel-pending, scheduled downgrade, canceled and unknown
  price states;
- the old plan can be repurchased after cancellation;
- the settle-window expiry never claims confirmation;
- plan-card numbers continue to derive from canonical catalogs.

### UI-05 — Proactive limits and downgrade recovery

**Findings:** `UI-020`, `UI-021`, `UI-022`, `UI-023`, `UI-024`
**Size:** L · **Release:** required · **Dependencies:** UI-04 for links/copy destination

**Scope**

- introduce `LimitMeter` and `EntitlementNotice` patterns derived from resolved entitlements;
- show stock, active-monitor, concurrent-run, symbol and history usage before submit;
- make MAX plan-aware;
- at monitor capacity, default to/save as disabled with clear explanation;
- replace “Enabled” + “Not scanning” with one effective state;
- add an account-level downgrade/compliance notice and recovery choices;
- show plan in the account menu; show role only when it adds admin meaning.

**Acceptance**

- Free 10/10, Starter 3/3 and downgraded personas see limits before editing;
- every refusal provides a relevant recovery: adjust, open running work, save disabled or see plans;
- no entitlement value is re-declared in web feature code;
- server enforcement remains authoritative and race-safe.

### UI-06 — Strategy Builder authoring semantics

**Findings:** `UI-013`, `UI-014`, `UI-015`
**Size:** M/L · **Release:** required · **Dependencies:** none

**Scope**

- new predicates start with an unset metric and author no logic;
- validation issue count stays neutral until a field is touched or save is attempted;
- duplicate rules are never created as a side effect of Add;
- replace permanently red Remove actions with neutral actions plus undo/conditional confirmation;
- remove the duplicate FINAL EXIT heading;
- use the strategy's name as the edit-page title;
- add header overflow actions for Rename/Delete and a Run backtest action;
- title the rename dialog “Rename strategy”.

**Acceptance**

- blank, one-level, duplicate, reorder, middle-rule removal and dirty/discard states on desktop and
  mobile;
- a new blank form has zero authored predicates and no red issue count;
- removing a populated level is recoverable;
- persisted V1/V2 strategy semantics and fingerprints do not change.

### UI-07 — Membership period truth

**Findings:** `UI-019`
**Size:** S/M · **Release:** required · **Dependencies:** none

**Scope**

- derive and display current, next or most-recent period by meaning, not storage order;
- show “Member now · since … · N periods” when current;
- make all periods reachable via a disclosure/dialog on touch and keyboard;
- retain the existing protection against replacing several periods accidentally.

**Acceptance**

- full, expired-only, future-only, current-open, current-bounded and multi-period fixtures;
- no tooltip is the only source of the current period;
- no write or normalisation semantics change.

### UI-08 — Entity workflow symmetry

**Findings:** `UI-008`, `UI-016`, `UI-030`
**Size:** M · **Release:** required for `UI-008` · **Dependencies:** UI-01

**Scope**

- add Run backtest to owned List, Strategy and Monitor detail headers with safe partial/full prefill;
- keep collection rows' single contextual Open action rather than adding a second visible action;
- use the owning collection as the back destination for built-ins;
- render `LogicPreview` unframed inside its section;
- keep New in the page header across loading, empty, error and populated states;
- empty regions explain the next step without moving the primary action.

**Stock Details decision**

Add “Add to list”. Do not create a direct stock Backtest action until the product defines which
persisted Stock List owns that stock. A silent temporary/one-stock list would violate the current
product model.

**Acceptance**

- own and built-in List/Strategy/Monitor paths lead to an equivalent Backtest setup;
- Guest actions keep their in-context prompt and intended `next` destination;
- action location does not change between page states.

### UI-09 — Dashboard and Monitor information hierarchy

**Findings:** `UI-025`, `UI-026`, `UI-048`, `UI-049`
**Size:** M/L · **Release:** required for `UI-025` · **Dependencies:** UI-01

**Scope**

- add Since to signal rows and rename the summary card “Current matches”;
- sort active before waiting, then by action/level and newest state transition;
- add status filters to Monitor detail;
- render signal resolution and not-evaluable reasons in product language;
- poll collections only while non-terminal/running state exists;
- tick relative ages without refetching the whole page;
- centralise rendered date/datetime/relative formatting;
- keep native date-input display untouched.

**Acceptance**

- active, pending, resolved, stale, history-derived and not-evaluable fixtures;
- no relative label stays frozen while the page remains open;
- polling stops when all work becomes terminal and cleans up on unmount;
- repeated symbols remain distinct signals; grouping is optional and must not hide monitor identity.

### UI-10 — Picker and select primitives

**Findings:** `UI-009`, `UI-035`, `UI-036`, `UI-045`
**Size:** L · **Release:** follow-up unless needed by UI-08 · **Dependencies:** UI-08 product rules

**Scope**

- implement `Select`, `EntitySelect` and `SecurityCombobox` as described in §3.5;
- make monitor ownership restrictions explicit rather than pretending built-ins do not exist;
- give stale ids an explicit unavailable option;
- use one request-failure mapper and respect `Retry-After`;
- align labels, loading and error behaviour without forcing single- and multi-select into identical
  interaction.

**Acceptance**

- blank, loading, results, empty, selected, already-in-list, stale reference, 429 and generic failure;
- correct listbox labelling and one documented meaning for `aria-selected` per mode;
- keyboard wrap, Enter, Escape, Backspace and focus return covered by tests.

### UI-11 — Collection scale and empty-state consistency

**Findings:** `UI-010`, `UI-012`
**Size:** M · **Release:** follow-up · **Dependencies:** UI-01, UI-08

**Scope**

- add a shared collection toolbar for client-side name search and sort when density warrants it;
- provide a phone sort control when table headers are hidden;
- add Monitor-detail status filters through UI-09 rather than a second filter implementation;
- use one compact collection empty-state composition;
- filtered-empty states always offer Clear filters.

Do not show permanent search chrome for a two-row built-in section. A reasonable default is to show
collection search at 10+ records, while sort remains available where order carries meaning.

**Acceptance**

- 0, 1, 9, 10, 25, 30 and 60 record fixtures;
- filtering resets pagination safely;
- the current selection and result count are announced;
- no server pagination is introduced while endpoints still return the full owned collection.

### UI-12 — Visual convergence without redesign

**Findings:** `UI-004`, `UI-007`, `UI-017`, `UI-018`, `UI-044`, `UI-056`, `UI-058`
**Size:** L but splittable by surface · **Release:** follow-up · **Dependencies:** UI-01, UI-10, UI-11

**Scope**

- update UI docs to make 880 px canonical and document the fluid compact-card grid;
- keep Your/Built-in sections but share column definitions and remove redundant badges;
- migrate Stock Details header/facts/errors/statuses to shared primitives;
- add Stock Details Add to list and a persistent chart legend;
- use one explicit “Price vs value” sign convention;
- align Auth controls/type tokens while retaining its standalone composition;
- codify context-specific button ordering;
- standardise Membership, Exit Rule and recent-view terminology and punctuation.

**Acceptance**

- no new local page-title, button or select scale;
- Stock Details still keeps its viewport-driven chart/history behaviour;
- the auth flow remains compact and self-contained at 390 px;
- docs and shipped CSS name the same responsive contract.

### UI-13 — Loading, error and not-found composition

**Findings:** `UI-027`, `UI-028`, `UI-029`, `UI-057`
**Size:** M · **Release:** follow-up, except any part required by UI-03 · **Dependencies:** UI-02

**Scope**

- add page-shaped header skeletons to entity details;
- use `EmptyState` inside `PageContainer` for gates, Stock status, Admin errors and not-found states;
- provide recovery everywhere it is meaningful;
- standardise privacy-preserving not-found wording:
  “{Thing} not found — it may have been deleted, or it belongs to another account.”;
- distinguish API failure from network-unreachable copy.

**Acceptance**

- exactly one `h1` or an accessible loading heading on every page state;
- no gate text touches the phone viewport edge;
- another account's object remains indistinguishable from a missing object;
- no access-control detail is leaked.

### UI-14 — Authentication and return-path consistency

**Findings:** `UI-040`, `UI-041`, `UI-042`, `UI-043`
**Size:** M · **Release:** UI-42 contract portion required; remainder follow-up · **Dependencies:** UI-00

**Scope**

- signed-in visits to login/register return safely to `next` or Dashboard;
- client-side required-field feedback prevents empty login requests;
- every sign-in entry point is built from the same safe-return helper;
- invalid password-reset links switch to a dedicated recovery state like verification links;
- preserve open-redirect protections and generic account-enumeration-safe copy.

**Acceptance**

- password, Google, verify, reset, topbar, Dashboard prompt and entity prompt paths;
- same-origin allow-listed `next` survives; external/invalid values are rejected;
- no real email or Google request is needed in tests.

### UI-15 — Shell, Admin and metadata hygiene

**Findings:** `UI-051`, `UI-052`, `UI-053`, `UI-054`, `UI-055`
**Size:** M · **Release:** follow-up · **Dependencies:** UI-12, UI-13

**Scope**

- replace the stale `/stocks` placeholder with a redirect now; design a research landing only as a
  separate product item;
- migrate Admin to shared header/table/error primitives and show “changes apply to everyone” while
  editing built-ins;
- make the account dropdown either a true keyboard menu or an accurately modelled disclosure;
- give the brand link `aria-current` on Dashboard; do not invent false active states for routes that
  are not navigation items;
- replace the Builder's bypassable native leave guard with the shared navigation guard;
- fix hydration mismatches; classify the expected guest session 401 separately in the audit harness;
- provide consistent route metadata and `· FactorSage` titles.

**Acceptance**

- keyboard-only account menu and unsaved-change navigation;
- no React hydration warning in the audited scenarios;
- Dashboard, collection, detail, auth, billing, Admin and not-found tab titles;
- Admin actions retain role enforcement and SYSTEM ownership semantics.

---

## 6. Finding-to-PR coverage

Every audit finding has one primary owner below. A PR may improve adjacent behaviour, but the
finding is closed only by its primary PR's acceptance criteria.

| Finding | Primary PR | Release disposition                             |
| ------- | ---------- | ----------------------------------------------- |
| UI-001  | UI-01      | blocker                                         |
| UI-002  | UI-01      | blocker                                         |
| UI-003  | UI-01      | ships with root fix                             |
| UI-004  | UI-12      | document 880; improve compact grid in UI-01     |
| UI-005  | UI-02      | blocker                                         |
| UI-006  | UI-01      | blocker                                         |
| UI-007  | UI-12      | follow-up; keep ownership groups                |
| UI-008  | UI-08      | blocker                                         |
| UI-009  | UI-10      | follow-up/shared picker                         |
| UI-010  | UI-11      | follow-up                                       |
| UI-011  | UI-01      | ships with card fix                             |
| UI-012  | UI-11      | follow-up                                       |
| UI-013  | UI-06      | blocker                                         |
| UI-014  | UI-06      | ships with Builder fix                          |
| UI-015  | UI-06      | ships with Builder fix                          |
| UI-016  | UI-08      | ships with workflow fix                         |
| UI-017  | UI-12      | follow-up; partial convergence only             |
| UI-018  | UI-12      | follow-up; Add to list, legend, sign convention |
| UI-019  | UI-07      | blocker                                         |
| UI-020  | UI-05      | blocker                                         |
| UI-021  | UI-05      | blocker                                         |
| UI-022  | UI-05      | ships with entitlement guidance                 |
| UI-023  | UI-05      | ships with entitlement guidance                 |
| UI-024  | UI-05      | ships with entitlement guidance                 |
| UI-025  | UI-09      | blocker                                         |
| UI-026  | UI-09      | ships with signal hierarchy                     |
| UI-027  | UI-13      | follow-up                                       |
| UI-028  | UI-13      | follow-up                                       |
| UI-029  | UI-13      | follow-up                                       |
| UI-030  | UI-08      | ships with workflow fix                         |
| UI-031  | UI-03      | blocker                                         |
| UI-032  | UI-03      | ships with result fix                           |
| UI-033  | UI-03      | spec corrected; retain two columns at 390       |
| UI-034  | UI-03      | ships with result fix where contract permits    |
| UI-035  | UI-10      | follow-up                                       |
| UI-036  | UI-10      | follow-up                                       |
| UI-037  | UI-04      | blocker                                         |
| UI-038  | UI-04      | ships with billing fix                          |
| UI-039  | UI-04      | ships with billing fix                          |
| UI-040  | UI-14      | follow-up                                       |
| UI-041  | UI-14      | follow-up                                       |
| UI-042  | UI-14      | contract portion required                       |
| UI-043  | UI-14      | follow-up                                       |
| UI-044  | UI-12      | follow-up                                       |
| UI-045  | UI-10      | follow-up                                       |
| UI-046  | UI-04      | blocker                                         |
| UI-047  | UI-04      | ships with billing fix                          |
| UI-048  | UI-09      | follow-up                                       |
| UI-049  | UI-09      | rendered dates only; native inputs accepted     |
| UI-050  | UI-01      | ships with row-action fix                       |
| UI-051  | UI-15      | follow-up                                       |
| UI-052  | UI-15      | follow-up                                       |
| UI-053  | UI-15      | follow-up/partially accepted                    |
| UI-054  | UI-15      | fix hydration; accept expected guest 401        |
| UI-055  | UI-15      | follow-up                                       |
| UI-056  | UI-12      | document per-context ordering                   |
| UI-057  | UI-13      | follow-up                                       |
| UI-058  | UI-12      | follow-up                                       |

---

## 7. Dependency order and safe parallelism

```text
UI-00 ────────────────→ UI-14

UI-01 ─→ UI-08 ──────→ UI-10 ─→ UI-12 ─→ UI-15
  │       │                         ↑
  ├───────┴→ UI-09                 │
  └────────→ UI-11 ────────────────┘

UI-02 ─→ UI-03
  └────→ UI-13 ───────────────────→ UI-15

UI-04 ─→ UI-05

UI-06        UI-07
```

Safe initial parallel work:

- UI-00 contract alignment;
- UI-01 containment;
- UI-02 form feedback;
- UI-04 billing truth;
- UI-06 Strategy Builder;
- UI-07 membership periods.

Avoid concurrent edits to the same shared primitives. In particular:

- UI-01 owns `DataTable`, `EntityReferenceChip` and `OverflowMenu` while active;
- UI-02 owns `WorkflowFooter` error/focus behaviour;
- UI-10 owns the picker/select primitives;
- UI-12 owns token/doc convergence after those contracts stabilise.

---

## 8. Verification strategy

### 8.1 Per-PR checks

Every PR runs:

- focused component/feature tests;
- `pnpm lint` and `pnpm typecheck`;
- the relevant hermetic browser specs at the affected widths/personas;
- the normal repository gate before handoff.

No UI cleanup test may contact real FMP, SMTP, Google or Stripe. Billing and email states remain
mocked; plan-limit refusals continue to use the real local API.

### 8.2 Small visual regression matrix

Do not regenerate/review all 642 screenshots on every PR. Maintain a small mandatory matrix:

| Persona/state                | 390 | 879 | 880 | 1,024 | 1,440 |
| ---------------------------- | --: | --: | --: | ----: | ----: |
| Guest core navigation/prompt |   ✓ |   – |   – |     – |     ✓ |
| Free at limits               |   ✓ |   – |   – |     ✓ |     ✓ |
| Pro-heavy long/dense data    |   ✓ |   ✓ |   ✓ |     ✓ |     ✓ |
| Downgraded                   |   ✓ |   – |   – |     – |     ✓ |
| Billing lifecycle states     |   ✓ |   – |   – |     – |     ✓ |
| Failure/loading/not-found    |   ✓ |   – |   – |     – |     ✓ |

Use 375 px where shell search behaviour changes. Run the full audit harness at the end of the
release-blocking wave and again after the consolidation wave.

### 8.3 Automated invariants to retain/add

- zero horizontal document overflow;
- menus stay within the visual viewport;
- one `h1` per settled page and an accessible loading state;
- no duplicate ids or unnamed controls;
- entity-specific accessible action names;
- current plan/limit values come from canonical entitlements;
- failed Backtests do not render result sections;
- ended/canceled billing statuses do not resolve to a current price;
- guest Backtest entitlement is false;
- long names are present in test fixtures, not only in screenshots;
- mobile card and desktop table remain one DOM representation.

---

## 9. Documentation changes required as work lands

Update documentation in the PR that establishes the rule, not in one final cleanup commit:

- `ai/architecture/ui-system.md`
  - allow grouped Your/Built-in collections;
  - make 880 px canonical;
  - define the fluid compact-card grid;
  - define `Notice`, `EntitlementNotice`, `EntitySelect`, `SecurityCombobox` and `Select` only once
    they exist;
- `ai/architecture/v1-visual-parity.md`
  - correct the KPI rule for small phones;
  - keep New in the header across collection states;
  - record the Backtest-from-entity header rule;
- `ai/architecture/frontend.md`
  - align the breakpoint and responsive contract;
- `docs/decisions/entitlements-v1.md`
  - ensure guest Backtest access and public flags match DEC-007;
- relevant product docs
  - effective vs configured Monitor state;
  - current membership display order;
  - failure/retry language where it reflects product semantics.

---

## 10. Evidence and repository hygiene

The audit branch currently adds approximately 81 MB, of which roughly 80 MB is 642 PNG files.
Merging it as-is would permanently add those binaries to normal clone/fetch history even if they
were deleted later.

Recommended handling:

1. keep `UI-audit` as an immutable evidence branch (or tag) while cleanup runs;
2. do **not** merge the screenshot commit directly into `main`;
3. put the report and this plan on a clean docs branch, linking evidence to the immutable audit
   ref; optionally keep only a small representative image set in normal Git;
4. store future full capture sets as CI workflow artifacts or another approved binary store with a
   retention policy;
5. keep `manifest.json`, the evidence index and the reproducible harness with whichever evidence
   location is chosen;
6. never upload real credentials/session state; the existing `.test` persona addresses are test
   data but should remain identified as such.

If the owner deliberately chooses to merge the complete evidence set, record that as an explicit
repository-size decision first. Git LFS helps future binary handling but does not retroactively make
the existing ordinary-Git commit small.

---

## 11. Definition of done for the cleanup programme

The programme is complete when:

- every `UI-001…UI-058` row has a merged fix or an explicit accepted/deferred decision;
- every P1 release criterion in §4.2 passes in the hermetic stack;
- the full audit harness produces no P1 finding and no unexplained automated-check regression;
- code and architecture docs agree on the responsive, collection and action contracts;
- no feature has introduced a duplicate page header, select, stock combobox, status system or
  error component;
- the visual result still looks like FactorSage: calm, dense, restrained and data-first;
- the evidence strategy does not permanently bloat the main repository without an explicit owner
  decision.

The desired result is not a visually different V3. It is V2 with one reliable grammar: the same
action in the same place, the same state told truthfully, and content that remains usable at every
supported width and plan state.
