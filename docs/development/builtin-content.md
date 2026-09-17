# Built-in content

The platform's built-in (`SYSTEM`) Lists, Strategies and Monitors, how they are created, and where
their data comes from. `docs/decisions/builtin-dashboard-signals-v1.md` is the product decision;
`apps/api/src/builtins/builtin-catalog.ts` is the canonical catalog, pinned by
`builtin-catalog.test.ts`.

## Commands

```bash
pnpm builtins:bootstrap     # deploy step: create any missing built-in by systemKey (DATABASE_URL)
pnpm monitors:scan-once     # run one Monitor cycle now; reconstructs the new Monitors' state
pnpm builtins:reset         # development: restore every built-in to the catalog (refused in production)
pnpm test:builtins:seed     # deterministic QA built-ins for Playwright (TEST_DATABASE_URL only)
```

- **Bootstrap never overwrites.** An existing `systemKey` is left exactly as an administrator last
  left it, whatever the catalog says now.
- **Reset restores.** Names, descriptions and order; membership and Buy Windows (removing members an
  administrator added); the Strategy definition, as a new version when it differs; the Monitor
  binding, as a rebind when it differs; published and globally enabled. `--allow-production` is
  required to run it with `NODE_ENV=production`.
- **Securities must already exist.** Membership resolves canonical `Security` rows on a supported
  exchange. A missing symbol fails the whole bootstrap before anything is written, naming every
  missing symbol; run the catalog synchronization (`POST /admin/securities/sync` as an
  administrator) and bootstrap again.
- **Monitor state is reconstructed, not seeded.** The bootstrap creates no state. The first cycle —
  scheduled, or `pnpm monitors:scan-once` — replays about a year of closed history per level and
  records at most one `reconstructed` occurrence and one transition per level
  (`ai/architecture/monitor-engine.md`, "Reconstruction").
- **Production administrator.** An ordinary user with `role = ADMIN`, created with `pnpm db:seed`
  from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in the environment. No credential is in source control, and
  the QA `ADMIN_USER` persona is a test account only.

## The catalog

| systemKey | Kind | Name | Binding |
| --- | --- | --- | --- |
| `sp500-growth-leaders` | List | S&P 500 Growth Leaders | 10 members |
| `nasdaq100-newcomers` | List | Nasdaq-100 Newcomers | 10 members |
| `recent-market-debuts` | List | Recent Market Debuts | 10 members |
| `value-and-trend` | Strategy | Value & Trend | BUY 100%, SELL 50%, one FINAL EXIT rule |
| `trend-confirmation` | Strategy | Trend Confirmation | BUY 100% with Trigger, trigger-only FINAL EXIT |
| `sp500-value-and-trend` | Monitor | S&P Value & Trend | `value-and-trend` × `sp500-growth-leaders` |
| `nasdaq-trend-confirmation` | Monitor | Nasdaq Trend Confirmation | `trend-confirmation` × `nasdaq100-newcomers` |
| `new-listings-trend-confirmation` | Monitor | New Listings Trend Confirmation | `trend-confirmation` × `recent-market-debuts` |

Level, condition and rule ids in the two definitions are permanent: a level id is Monitor identity.

## Verified eligibility dates

Every date was checked on 2026-09-17 against the primary source below. All 25 dated entries match
the decision document, and no substitution was needed.

**S&P 500 Growth Leaders.** AAPL, MSFT, NVDA, AMD and META have been continuous S&P 500 members
since before the five-year window and are *Always eligible*. Additions, each effective before the
open on the date shown (S&P Dow Jones Indices press releases):

| Symbol | First day as a member | Source |
| --- | --- | --- |
| PANW | 2023-06-20 | press.spglobal.com, 2023-06-02 |
| ABNB | 2023-09-18 | press.spglobal.com, 2023-09-01 |
| UBER | 2023-12-18 | press.spglobal.com, 2023-12-01 |
| CRWD | 2024-06-24 | press.spglobal.com, 2024-06-07 |
| PLTR | 2024-09-23 | press.spglobal.com, 2024-09-06 |

**Nasdaq-100 Newcomers.** Nasdaq announcements; none of the ten was removed from the index between
its inclusion and 2026-09-17 (annual reconstitutions 2022–2025 and the June 2026 quarterly change
were checked), so every window is open-ended.

| Symbol | First day as a member | Source |
| --- | --- | --- |
| HON | 2021-07-21 | GlobeNewswire, 2021-07-15 (listing moved from NYSE) |
| FTNT, DDOG | 2021-12-20 | GlobeNewswire, annual changes 2021-12-11 |
| ODFL | 2022-01-24 | ir.nasdaq.com (replaced PTON) |
| FANG | 2022-12-19 | GlobeNewswire, annual changes 2022-12-10 |
| ROP | 2023-12-18 | GlobeNewswire, annual changes 2023-12-09 |
| AXON, MSTR | 2024-12-23 | nasdaq.com, annual changes 2024-12-13 |
| MPWR, WDC | 2025-12-22 | GlobeNewswire, annual changes 2025-12-13 |

Notes: HON completed a 1-for-2 reverse split and the Honeywell Aerospace (HONA) spin-off on
2026-06-29, and is now named Honeywell Technologies under the same ticker; its history is
provider-adjusted. MSTR is now Strategy Inc. under the same ticker. ALAB and CRWV (in Recent Market
Debuts) joined the Nasdaq-100 on 2026-06-22, which does not affect their debut-based windows.

**Recent Market Debuts.** First public trading day, from each company's IPO pricing release:

| Symbol | First trading day | Venue |
| --- | --- | --- |
| HOOD | 2021-07-29 | Nasdaq |
| RIVN | 2021-11-10 | Nasdaq |
| MBLY | 2022-10-26 | Nasdaq |
| CAVA | 2023-06-15 | NYSE |
| ARM | 2023-09-14 | Nasdaq |
| ALAB | 2024-03-20 | Nasdaq |
| RDDT | 2024-03-21 | NYSE |
| CRWV | 2025-03-28 | Nasdaq |
| CRCL | 2025-06-05 | NYSE |
| FIG | 2025-07-31 | NYSE |

The exact source URL of every dated member is on its catalog entry.

## Calibration (2026-09-17)

Measured on the development database with live provider data, before deciding whether section 12's
numeric tuning was needed. **No threshold was changed.**

**Current state after the first real cycle** (66 of 70 levels reconstructed from history):

| Monitor | ACTIVE | PENDING_TRIGGER |
| --- | --- | --- |
| S&P Value & Trend | 7 (BUY: ABNB, NVDA · SELL: AAPL, AMD, MSFT, PLTR · FINAL EXIT: UBER) | 0 (no trigger) |
| Nasdaq Trend Confirmation | 4 (BUY: DDOG, FANG, FTNT, WDC) | 1 (ROP) |
| New Listings Trend Confirmation | 3 (BUY: ALAB, ARM · FINAL EXIT: CRCL) | 1 (HOOD) |

16 Dashboard rows of 70 evaluated levels — several active, setups waiting, far from everything
matching.

**Intrinsic-value availability for Value & Trend** (Balanced blend, trailing 262 sessions): AAPL,
ABNB, META, MSFT, NVDA, PLTR, UBER 262/262; AMD 91/262; PANW 190/262 and none since 2026-06-03; CRWD
0/262. CRWD's and PANW's BUY and SELL levels are therefore `NOT_EVALUABLE` today — reported as such,
never treated as false.

**Five-year Backtests** (2021-09-17 → 2026-09-16, $100,000, 10 positions, no contributions, run as
the FREE QA user through the real plan gates and worker):

| Strategy × List | Trades | BUY / SELL / FINAL EXIT | Return | Benchmark | Max drawdown |
| --- | --- | --- | --- | --- | --- |
| Value & Trend × S&P 500 Growth Leaders | 98 | 49 / 3 / 46 | +15.2% | +70.8% | 9.8% |
| Trend Confirmation × Nasdaq-100 Newcomers | 134 | 69 / 0 / 65 | −5.3% | +70.8% | 18.3% |
| Trend Confirmation × Recent Market Debuts | 70 | 36 / 0 / 34 | +32.8% | +70.8% | 39.9% |

Every BUY fell inside its member's window; the windows visibly open during the run (ABNB's first buy
is 2023-09-18, MPWR's 2025-12-22, UBER's first eligible day is 2023-12-18 and its first buy
2024-11-01). The built-ins are onboarding demonstrations of the product's mechanics, not investment
recommendations; their returns are reported, not tuned.
