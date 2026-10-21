-- The Monitor Signal table, keyset-paged (docs/decisions/monitor-eod-v2.md §6.2).
--
-- Resolved occurrences are ordered by the session that ended them, or — for an ending no
-- observation made (an edit, a removed member, a rebind) — by the New York day it was recorded.
-- That order was an expression evaluated over every resolved row of a Monitor on every page; it is
-- now a column, so it can be indexed and continued from a cursor.
--
-- `resolvedSession` is maintained by a trigger rather than by each writer: the worker resolves
-- occurrences in three places and the API in one (a rebind), and a trigger keeps every one of them,
-- and every seed, in agreement. The New York day is now computed from `resolvedAt` as the UTC
-- instant it is (it is stored without a zone); the old expression read it as New York local time,
-- which put an administrative ending recorded between 00:00 and 05:00 UTC on the next day.

ALTER TABLE "MonitorSignal" ADD COLUMN "resolvedSession" DATE;

CREATE FUNCTION "MonitorSignal_resolvedSession"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."resolvedSession" := CASE
    WHEN NEW."resolvedAt" IS NULL THEN NULL
    ELSE COALESCE(
      NEW."resolvedObservationDate",
      ((NEW."resolvedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York')::date
    )
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MonitorSignal_resolvedSession"
BEFORE INSERT OR UPDATE ON "MonitorSignal"
FOR EACH ROW EXECUTE FUNCTION "MonitorSignal_resolvedSession"();

UPDATE "MonitorSignal"
SET "resolvedSession" = COALESCE(
  "resolvedObservationDate",
  (("resolvedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York')::date
)
WHERE "resolvedAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "MonitorSignal_active_order_idx" ON "MonitorSignal"("monitorId", "resolvedAt", "observationDate" DESC, "detectedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "MonitorSignal_resolved_order_idx" ON "MonitorSignal"("monitorId", "resolvedSession" DESC, "resolvedAt" DESC, "id" DESC);
