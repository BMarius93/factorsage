# ADR 0001 — pnpm monorepo

## Decision

Use pnpm workspaces for the V2 monorepo.

## Why

The product has three deployable processes and several shared packages. Workspace dependencies make ownership explicit without publishing internal npm packages.

## Consequence

Avoid adding Nx/Turborepo until repository scale proves they are needed.
