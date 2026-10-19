-- Additive: the first day a resolved constituent's security prices are its own history, set only
-- by an identity correction (docs/decisions/sp500-historical-pit-v1.md §4.1). Null keeps every
-- existing row's meaning.
ALTER TABLE "IndexConstituent" ADD COLUMN "securityFrom" DATE;
