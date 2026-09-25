export const ALTERNATIVE_DATA_LOGGER = Symbol("ALTERNATIVE_DATA_LOGGER");

/**
 * The alternative-data store, re-exported under this module's own token.
 *
 * It resolves to the **same** `PrismaAlternativeDataStore` instance `StocksModule` provides; the alias
 * exists only so this module's providers name a token of their own rather than importing the stocks
 * module's internal one.
 */
export const ALTERNATIVE_DATA_STORE_TOKEN = Symbol(
  "ALTERNATIVE_DATA_STORE_TOKEN",
);
