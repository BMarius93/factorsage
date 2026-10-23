# Pro+ and premium built-in content

Entitlements V2 (`docs/decisions/entitlements-v2.md`):

- `UserPlan` gains `PRO_PLUS` ("Pro+"). Every existing user keeps the plan they have; only
  `BillingReconciliationService`, through `changeUserPlan`, ever moves a user onto it.
- `StockList.premium` and `Strategy.premium` mark premium built-ins, defaulted `false`. A CHECK
  constraint holds them to `SYSTEM` rows. The S&P 500 Historical PIT List, when it exists, is marked
  premium here; the projection that writes it sets the flag from now on.

**Deploy order.** A build that predates this migration throws on a `PRO_PLUS` row
(`resolveEntitlements` refuses an unknown plan rather than reading it as unlimited). Migrate, then
deploy the API and every worker kind, and only then configure `STRIPE_PRICE_PRO_PLUS_MONTHLY` — no
`PRO_PLUS` row can exist before a Pro+ price is purchasable.

**Rollback.** `ALTER TABLE "StockList" DROP CONSTRAINT "StockList_premium_system_only_check", DROP
COLUMN "premium"; ALTER TABLE "Strategy" DROP CONSTRAINT "Strategy_premium_system_only_check", DROP
COLUMN "premium";` loses only the flags. PostgreSQL cannot drop an enum value: rolling back
`PRO_PLUS` means moving any such user to another plan and recreating the type, which is why the
deploy order above matters more than the rollback.
