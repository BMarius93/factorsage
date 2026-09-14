# Add `RecentSecurityView`

Adds the one table behind the global search dropdown's RECENT SEARCHES section. Purely additive:
no existing table, column, index or row is touched, so it rolls back cleanly.

The table is a **recency set, not a view log**:

- The primary key is `(userId, securityId)`, so a user has at most one row per security. Viewing
  the same stock again moves `viewedAt` instead of appending, which is what makes "no duplicates"
  a database rule rather than an application convention.
- `viewedAt` is the whole payload. There is no counter, no source, no session and no search term —
  what a user typed to reach a stock is not what this records, and adding any of that would turn a
  convenience projection into analytics.
- The write path also trims the set to `RECENT_SECURITY_LIMIT` (`@intrinsic/contracts`), so the
  table stays bounded per user even though it is written on every Stock Details view.
- `@@index([userId, viewedAt(sort: Desc)])` serves the only read there is: this user's newest rows.

Both foreign keys cascade, deliberately unlike `StockListItem`'s `Restrict`. A list membership is
user-authored content that must never vanish through a catalog mutation; a recent view is
disposable convenience data, so a deleted catalog row should take its recent-view rows with it.
That cascade is also what implements "a security that no longer exists is silently omitted" — the
dropdown cannot render a broken entry, because there is no row left to render.

Guests are deliberately absent from this table. `docs/decisions/entitlements-v1.md` derives guest
access from the absence of a session and forbids an anonymous `User` row, so a signed-out visitor's
recents live in that browser's `localStorage` and are resolved against the catalog on read.

Rollback is `DROP TABLE "RecentSecurityView";`, which loses only the dropdown's recent rows — the
next few stock views rebuild them.
