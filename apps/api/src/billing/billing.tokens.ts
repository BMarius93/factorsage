export const BILLING_LOGGER = Symbol("BILLING_LOGGER");

/**
 * `StripeBillingConfig | null` — null when this deployment has no Stripe configuration.
 *
 * Null is a first-class state, not a missing provider: the billing module still compiles and its
 * routes still answer, reporting billing as unavailable. That is what lets every other suite in the
 * workspace run with no Stripe secret anywhere.
 */
export const STRIPE_BILLING_CONFIG = Symbol("STRIPE_BILLING_CONFIG");

/**
 * `StripeGateway | null` — the Stripe boundary, or null when billing is not configured.
 *
 * An integration test overrides this provider with an in-memory fake and exercises the real
 * reconciliation rules with no network at all.
 */
export const STRIPE_GATEWAY = Symbol("STRIPE_GATEWAY");

/** `BillingCatalog | null` — the configured price allowlist. */
export const BILLING_CATALOG_TOKEN = Symbol("BILLING_CATALOG_TOKEN");
