# Add `PasswordResetToken`

Adds the one table password recovery needs. Nothing else changes: no existing table, column,
index or row is touched, so the migration is purely additive and rolls back cleanly.

The shape deliberately mirrors `EmailVerificationToken`, because the two solve the same problem
and must not solve it differently:

- `tokenHash` is unique and is the **only** representation of the token that is ever persisted.
  The plaintext exists solely inside the outbound email. A database leak therefore yields no
  usable reset link.
- `userId` is unique, which is what makes "one outstanding token per user" a database rule rather
  than an application convention: issuing a new link upserts the row and the previously mailed
  link stops working.
- `expiresAt` bounds how long a link stays redeemable, from
  `AUTH_PASSWORD_RESET_TTL_SECONDS`.
- The row cascades from `User`, like every other user-owned row.

It is a separate table rather than a `kind` column on `EmailVerificationToken` because the two
lifecycles are independent: requesting a password reset must not invalidate a pending
verification link, and vice versa. Sharing a table would make the per-user uniqueness constraint
mean "one token of any purpose", which is not the rule either flow wants.

Rollback is `DROP TABLE "PasswordResetToken";`, which loses only outstanding reset links —
their owners simply request a new one.
