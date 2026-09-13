/**
 * The concurrency rules shared by FactorSage's two one-row-per-user auth tokens —
 * `EmailVerificationToken` and `PasswordResetToken`.
 *
 * Both are the same lifecycle: a random plaintext token mailed to the owner, only its SHA-256
 * hash persisted, at most one outstanding token per user, issuance rotating the previous one
 * away, an expiry, and a single-use redemption. They live here together so the two cannot drift
 * into subtly different answers to the same question.
 *
 * The question is this. Issuance upserts by `userId`, so rotating a token **reuses the same row**:
 * same `id`, new `tokenHash`, new `expiresAt`. Anything that acts on a row it read earlier — a
 * cleanup, or the consuming delete itself — is therefore acting on an identity that may already
 * belong to a different token. Addressing the row by `id` alone would silently hit whatever now
 * lives there.
 *
 * Being inside `$transaction` does not fix that. At PostgreSQL's READ COMMITTED default a
 * statement re-reads the rows it writes, so a `DELETE` issued after a concurrent rotation
 * committed finds and deletes the *new* row, and reports a count of one for it. The earlier
 * `SELECT` is never authoritative; the state-changing statement has to carry the identity it
 * intends to act on.
 */

/** The one delegate method these rules need, on the Prisma client or inside a transaction. */
export type RotatingTokenRows = {
  deleteMany(args: {
    where: {
      id: string;
      tokenHash: string;
      expiresAt: { gt: Date } | { lte: Date };
    };
  }): Promise<{ count: number }>;
};

/** The identity a caller read, and must still be acting on for its write to count. */
export type RotatingTokenRow = {
  readonly id: string;
  readonly tokenHash: string;
};

/**
 * Consumes exactly the token that was read, and reports whether this call is what consumed it.
 *
 * The delete is the concurrency gate, not the preceding read: `true` means this statement removed
 * that specific unexpired token and the caller has earned the right to complete the redemption.
 * `false` means the row no longer holds it — already consumed by a concurrent redemption, rotated
 * away by a new issuance, or expired since the read — and the caller must reject without
 * performing the effect the token was supposed to authorize.
 *
 * `expiresAt` is re-checked here rather than trusted from the read, so a token that lapses between
 * the two cannot be consumed.
 */
export async function consumeRotatingToken(
  rows: RotatingTokenRows,
  row: RotatingTokenRow,
): Promise<boolean> {
  const { count } = await rows.deleteMany({
    where: { ...row, expiresAt: { gt: new Date() } },
  });
  return count === 1;
}

/**
 * Clears a token found expired, if it is still the expired token that was read.
 *
 * Opportunistic: nothing depends on it, because one expired row per user is bounded, replaced by
 * the next issuance and cascaded with the account. It is conditional for the same reason the
 * consume is — a rotation between the read and this statement would otherwise throw away a link
 * that had just been mailed, leaving its owner holding an already-dead token.
 */
export async function discardExpiredRotatingToken(
  rows: RotatingTokenRows,
  row: RotatingTokenRow,
): Promise<void> {
  await rows.deleteMany({ where: { ...row, expiresAt: { lte: new Date() } } });
}
