# The member catalog: who a Congressional rule may select

A Congressional Trading rule selects members of Congress from a catalog (`AlternativeDataActor`).
Until 2026-10-11 that catalog held only the members some loaded disclosure had named, and
disclosures are loaded lazily, per security — so a member could be missing from the picker for no
better reason than that nobody had opened a stock they traded.

The catalog is now synchronized with the provider's **member directory**: every member in office
and every former member the directory lists, whether or not a disclosure of theirs has ever been
loaded. This is the operator's runbook: what the provider offers, what a synchronization does and
refuses to do, how to run it, and what it still does not cover.

`docs/alternative-data-signals.md` holds the product decision. Disclosure ingestion is unchanged
and is not described here.

## 1. What the provider offers (verified live, 2026-10-11)

The endpoint is `GET /stable/senate-profile`. Despite its name it holds **both chambers**; there is
no House counterpart (`house-profile` answers HTTP 404).

| Question                                 | Answer                                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Can this subscription read it?           | Yes. HTTP 200, no restriction.                                                                                                                                                                                     |
| How is it filtered?                      | `active=true` (also the default) returns members in office; `active=false` returns former members. No row belongs to both.                                                                                         |
| How is it paged?                         | `page` is a page index. A page holds at most 500 rows; the page after the last is an empty array.                                                                                                                  |
| How many identities?                     | **1,261**: 540 in office (500 + 40) and 721 former (500 + 221).                                                                                                                                                    |
| What identifies a member?                | `senateID`, which is the **bioguide id** — the same field, with the same value, that `senate-trades` and `house-trades` carry. All 1,261 are bioguide-shaped and distinct.                                         |
| What else does a row carry?              | `firstName`, `lastName`, `latestState`, `latestPosition`, `active`, and `birthDate`, `latestParty`, `image`, `yearsActive`, which nothing here reads.                                                              |
| Is there position history?               | No. `latestPosition` is the latest position only: `Representative`, `Senator`, or an office outside Congress (`Vice President`, `President`) for a former member who went on to hold one.                          |
| Are there aliases or nicknames?          | No. The directory spells the senator people call Ted Cruz `Rafael Edward` `Cruz`.                                                                                                                                  |
| Do names agree with a disclosure's name? | Often not. Of the 217 members this installation's disclosures had named, 99 are spelled differently by the directory — `Bill Cassidy` against a disclosure's `William Cassidy`. The family name agrees on all 217. |
| What does a synchronization cost?        | Six requests, a few seconds: each half is read until its first empty page (three requests each). No rate-limit headers are returned; the requests go through the shared provider gate like every other.            |

**Reconciliation with the identities that already existed.** All 217 members in the development
database were found in the directory by bioguide id: 153 in office, 64 former, none unmatched and
none ambiguous. The other 1,044 directory identities were not in the catalog: 1,041 were added and
3 declined (section 2). Two pairs of directory members share a full name (`Robert Menendez`,
`Patrick Murphy`) under different ids, which is why a name is never an identity.

**What is not known.** The provider does not say how far back "former" reaches, so 721 is what it
lists, not a claim that it lists every former member. It does not document a rate limit for this
endpoint. Both are observations, not guarantees.

## 2. What a synchronization does

One run reads the whole directory and then writes it, as one transaction.

- **Adds** every member the catalog does not hold, with the directory's name, chamber and state.
- **Records the directory's spelling** of every member it does hold (`profileName`), beside the
  label their disclosures gave them. The picker searches both spellings.
- **Follows the directory's label** — name, chamber, state — only for a member no loaded disclosure
  names. Once a disclosure has named a member, their label is their disclosures', exactly as it was
  before this existed, because ingestion refreshes it on every read and two writers of one label
  would undo each other.

Identity is the bioguide id and nothing else. A member both sources know is one row with one
canonical id, whichever source saw them first.

### What it never does

| It never…                                            | Because                                                                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deletes or merges a member                           | A member the directory stops listing keeps their row, their id, and every strategy, snapshot and Monitor that names them.                                            |
| changes a canonical id                               | Strategies store these ids. Existing rows are matched by bioguide id and updated in place.                                                                           |
| makes an identity from a name                        | A directory row with no bioguide id is dropped; one whose id is not bioguide-shaped is declined.                                                                     |
| writes a disclosure, coverage or dataset state       | It is an identity directory. Whether a metric is evaluable for a security is decided by that security's ingested coverage, which a synchronization cannot reach.     |
| changes what a metric counts                         | No metric reads this table. A member it added has no disclosures; selecting them counts nothing where coverage reaches and is still not evaluable where it does not. |
| asks the provider anything when the picker is opened | The picker reads PostgreSQL only.                                                                                                                                    |

### What it declines, and reports

A declined row is not written, is counted, and is named in the report.

| Reason             | Meaning                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO_CHAMBER`       | The latest position is not a seat in Congress and no disclosure has named the member, so there is no chamber to file them under. Three on 2026-10-11: `B000444` (President), `H001075` and `P000587` (Vice President). A member in this position who _is_ already in the catalog keeps the chamber their disclosures gave them — JD Vance stays filed under the Senate. |
| `MALFORMED_ID`     | The identifier is not a bioguide id. None observed.                                                                                                                                                                                                                                                                                                                     |
| `CONFLICTING_ROWS` | The directory listed one identifier twice and the rows disagree, or listed it as both in office and former. Neither version is written. None observed.                                                                                                                                                                                                                  |
| `UNNAMED`          | No name. None observed.                                                                                                                                                                                                                                                                                                                                                 |

### What makes a run fail

A failed run writes **nothing**: the catalog is exactly as the last complete run left it, and the
state still reports when that was.

| Code                             | Meaning                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PROVIDER_UNAVAILABLE`           | A page could not be read after the client's own retries — an outage, a timeout, or the subscription being refused. |
| `DIRECTORY_EMPTY`                | A half came back empty. The real directory is never without members in office or without former ones.              |
| `DIRECTORY_FILTER_NOT_HONOURED`  | A row did not belong to the half that was asked for, or did not state `active` at all.                             |
| `DIRECTORY_PAGING_NOT_ADVANCING` | A page repeated rows already received instead of moving on.                                                        |
| `DIRECTORY_TOO_LARGE`            | A half was still returning rows after 20 pages.                                                                    |
| `CLAIM_LOST`                     | The run outlived its ten-minute claim while reading, so another run may have started.                              |
| `WRITE_FAILED`                   | The directory was read whole but the transaction did not commit.                                                   |

A half ends at its first **empty** page, never at a short one. The page size is a fact about the
provider today; a walk that stopped at "fewer than 500 rows" would silently truncate the directory
the day that cap was lowered.

## 3. Running it

Two ways in, one run. Both use the same service, the same shared provider gate and the same claim,
so they cannot run beside each other.

```bash
pnpm data:congress-members:sync                          # synchronize now
pnpm data:congress-members:sync --if-older-than-days 7   # asks nothing while the catalog is fresh
pnpm data:congress-members:sync --status                 # what is stored; the provider is not asked
pnpm data:congress-members:sync --json                   # the same report as one JSON document
```

```http
POST /admin/congress-members/sync      # ADMIN session; 200 counts, 409 already running, 503 failed
GET  /alternative-data/actors/catalog  # no session; SYNCHRONIZED | NOT_SYNCHRONIZED | SYNCHRONIZATION_FAILED
```

The command targets `DATABASE_URL`, prints the **name** of the database it is connected to, and
exits non-zero when a run failed. It refuses a database whose name contains `test` or `matrix`:
those are fixtures and copies, and a provider payload in either is a defect. `--status` is allowed
anywhere.

A complete run prints what it did:

```text
Synchronized (run 1), 6 provider request(s).
In the directory:      1261 (540 in office, 721 former)
Added to the catalog:  1041
Updated:               217 (0 relabelled)
Unchanged:             0
Declined:              3
Kept, not in the directory: 0
    NO_CHAMBER: 3
    declined B000444: NO_CHAMBER (President)
```

That is the real first run of 2026-10-11, against a throwaway copy of the development database's
217 members and their 9,187 disclosures. Afterwards those 217 rows were byte-identical in id,
label, chamber, state and district; a second run added and updated nothing.

### First synchronization

1. Deploy the release. The migration (`20261011180000_congress_member_catalog`) adds one nullable
   column and one table; it changes and removes nothing.
2. `pnpm data:congress-members:sync --status` — expect `never`.
3. `pnpm data:congress-members:sync`.
4. Read the report. `Added` should be near 1,040 on a database that has loaded disclosures and
   near 1,257 on one that has loaded none; `Declined` should be a handful of `NO_CHAMBER`.

Until step 3 the picker behaves exactly as before and says so: the directory has not been loaded
yet, and only members with loaded disclosures can be found.

### Keeping it current

**Nothing schedules a run.** Membership changes at elections, and between them only by a special
election, a resignation or a death, so the catalog goes stale slowly — and a member the directory
has not been asked about yet still enters the catalog the old way, when a disclosure of theirs is
loaded. Run it:

- as a deploy step, `pnpm data:congress-members:sync --if-older-than-days 7`, which costs no
  provider request unless a week has passed; or
- from whatever scheduler the deployment already has, weekly; and
- once after an election's results are sworn in.

A run is safe at any time, including during market hours: it takes one of the provider gate's
concurrency slots for a few seconds and writes only identity rows.

An automatic schedule inside the worker is a deliberate follow-up, not an omission: `AGENTS.md`
invariant 15 requires any further recurring job to be another instance of the durable-claim
schedule with its own worker child, which is an architectural addition to decide on its own. The
state table already carries the claim columns such a schedule would use.

### When a run fails

Read the code (section 2) and run it again; a run is safe to repeat and a later complete run
clears the failure. Nothing needs undoing, because a failed run wrote nothing. `--status` shows the
last complete run and the last failure separately, so a catalog that was synchronized last week and
failed to refresh today is not mistaken for one that was never loaded.

Two runs cannot overlap. A second caller is told one is already running and the provider is not
asked. If a run's process dies, its claim expires after ten minutes and the next run proceeds.

## 4. What the picker says

`GET /alternative-data/actors/catalog` reports what a synchronization did, from one stored row.

| State                    | The picker says, beside an empty search                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `SYNCHRONIZED`           | No current or former member of Congress matches.                                                                           |
| `NOT_SYNCHRONIZED`       | The member directory has not been loaded yet, so only members with disclosures FactorSage has already loaded can be found. |
| `SYNCHRONIZATION_FAILED` | The member directory could not be loaded, so only members with disclosures FactorSage has already loaded can be found.     |

A catalog that was synchronized once stays `SYNCHRONIZED` through a later failed run: it still
holds what the last complete run wrote. `SYNCHRONIZATION_FAILED` means a run was attempted and none
has ever completed.

The warning that the list depends on which disclosures were loaded is shown in the two states where
it is true, and not in the one where it is not.

## 5. Finding a member by name

A member has up to two spellings, both the provider's own: the one their disclosures use, which is
the label, and the directory's. A search matches either, so `Bill Cassidy` finds the senator shown
as `William Cassidy`.

When a term of several words matches nobody whole, the members whose names share some of its words
are returned instead: those sharing more words first, and among equals those sharing the term's
**last** word — the family name — first. The provider holds no nicknames, so `Ted Cruz` still
matches nobody whole, and is found by the surname.

No alias is invented and no fuzzy matching is done. A nickname the provider does not hold — Ted,
Chuck, Mitch — is found only through the family name. Storing nicknames would need a source for
them, and there is none here.

## 6. What it still does not cover

- **A former member the directory does not list** is in the catalog only if a loaded disclosure
  names them.
- **A member newly sworn in** is missing until the next run, or until a disclosure of theirs is
  loaded.
- **A member whose latest position is outside Congress** and who has no loaded disclosure
  (`NO_CHAMBER`) cannot be selected. Three people today.
- **Chamber is the latest one the product was told.** Four members who moved from the House to the
  Senate are still filed under the House, because their loaded disclosures are House disclosures.
  This is a label; a rule's own Chamber filter reads the chamber of each disclosure, not the
  member's.
- **Being in the catalog says nothing about trading.** A member who is found may have disclosed
  nothing, and a rule that selects only such members reads zero wherever a security's coverage
  reaches. That is a true reading, not a gap.
- **The QA matrix and test databases are never synchronized.** The matrix receives members by being
  provisioned from the development database; the hermetic E2E stack seeds its own fictional
  members and records its catalog as synchronized.
