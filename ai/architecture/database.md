# Database Architecture

V2 has one Prisma schema and one migration history under `packages/database/prisma`.

API and worker may both depend on `@intrinsic/database`, but they do not share an in-memory PrismaClient. Each OS/container process owns its own client and pool.

Do not put Prisma in `apps/web`.

Initial engine: PostgreSQL. Do not change database engine as part of unrelated rewrite work.

## Current product model

Migration `20260822183050_add_user_auth` adds the first product table: the minimal `User` identity
model and `UserRole` enum (`USER`, `ADMIN`). PostgreSQL owns the unique email constraint. Email is
normalized by application write/lookup paths, and `passwordHash` is nullable for future external
identity compatibility.

Migrations `20260823120000_add_stock_data_loader` and
`20260823160000_add_stock_dataset_coverage` add UUID-based Security identity, current profile,
split-adjusted daily prices, versioned daily technicals, completed weekly bars/generic weekly
technical storage, dataset state and exact successful coverage intervals, and point-in-time
intrinsic-value/blend snapshots. Symbol is indexed lookup data and is never the durable primary
key. Dataset state watermarks optimize reads; coverage intervals, not inferred calendar rows,
drive missing-range subtraction.
