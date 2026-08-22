# ADR 0002 — One Prisma schema

## Decision

V2 uses one canonical Prisma schema and one migration history.

## Why

The old repository had overlapping Prisma ownership across frontend/backend/worker, increasing drift and ambiguity.

## Consequence

API and worker share the package but create separate process-local clients/pools.
