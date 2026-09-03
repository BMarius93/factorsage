export const STOCK_DATA_STORE = Symbol("STOCK_DATA_STORE");
export const STOCK_DATA_PROVIDER = Symbol("STOCK_DATA_PROVIDER");
export const STOCK_DATA_CACHE = Symbol("STOCK_DATA_CACHE");
export const STOCK_DATA_COORDINATOR = Symbol("STOCK_DATA_COORDINATOR");
export const STOCK_DATA_REDIS = Symbol("STOCK_DATA_REDIS");
export const STOCK_DATA_SERVICE = Symbol("STOCK_DATA_SERVICE");
export const SECURITY_CATALOG_SERVICE = Symbol("SECURITY_CATALOG_SERVICE");

/**
 * Retained years of history this deployment can serve, as the Stock Details surface sees it.
 *
 * Provided rather than read from configuration inside the controller so the HTTP layer stays a
 * thin projection and a test can pin the horizon without pinning the environment.
 */
export const STOCK_DETAILS_RETENTION_YEARS = Symbol(
  "STOCK_DETAILS_RETENTION_YEARS",
);
