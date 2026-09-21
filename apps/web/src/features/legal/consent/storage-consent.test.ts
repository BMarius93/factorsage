import {
  STORAGE_CONSENT_KEY,
  STORAGE_CONSENT_VERSION,
} from "@intrinsic/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  preferencesAllowed,
  readStorageConsent,
  subscribeToStorageConsent,
  writeStorageConsent,
} from "./storage-consent";

/**
 * The consent record's own rules, tested without React.
 *
 * Three of these are the ones that decide whether the product is lawful rather than merely
 * working: undecided is never permission, a browser that blocks site data fails to "nothing
 * optional", and a record written for a different version of the question is not honoured.
 */
describe("storage consent", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("treats no record as undecided, and undecided as not permitted", () => {
    expect(readStorageConsent()).toBeNull();
    expect(preferencesAllowed(null)).toBe(false);
  });

  it("round-trips a decision in both directions", () => {
    const allowed = writeStorageConsent(true);
    expect(allowed.preferences).toBe(true);
    expect(allowed.version).toBe(STORAGE_CONSENT_VERSION);
    expect(Date.parse(allowed.decidedAt)).not.toBeNaN();
    expect(preferencesAllowed(readStorageConsent())).toBe(true);

    writeStorageConsent(false);
    expect(readStorageConsent()?.preferences).toBe(false);
    expect(preferencesAllowed(readStorageConsent())).toBe(false);
  });

  it("does not honour a record written for a different version of the question", () => {
    // A material change to what is being asked invalidates the answer. It is not migrated and
    // not read as permission: the visitor is asked again.
    window.localStorage.setItem(
      STORAGE_CONSENT_KEY,
      JSON.stringify({
        version: "0",
        preferences: true,
        decidedAt: new Date().toISOString(),
      }),
    );
    expect(readStorageConsent()).toBeNull();
  });

  it("does not honour a malformed or hand-edited record", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ version: STORAGE_CONSENT_VERSION }),
      JSON.stringify({
        version: STORAGE_CONSENT_VERSION,
        preferences: "yes",
        decidedAt: "now",
      }),
    ]) {
      window.localStorage.setItem(STORAGE_CONSENT_KEY, raw);
      expect(readStorageConsent(), raw).toBeNull();
    }
  });

  it("resolves to undecided when the browser blocks site data", () => {
    // `localStorage` throws outright when site data is blocked. Failing to "undecided" is the
    // safe direction: nothing optional runs, and the product still works.
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("The operation is insecure.");
    });
    expect(readStorageConsent()).toBeNull();
  });

  it("still reports the choice for this page session when the store refuses the write", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    // The visitor's decision is honoured now even though it cannot be remembered next visit.
    expect(writeStorageConsent(true).preferences).toBe(true);
  });

  it("notifies on a cross-tab change, including a whole-store clear", () => {
    const seen: (boolean | null)[] = [];
    const unsubscribe = subscribeToStorageConsent((choice) =>
      seen.push(choice?.preferences ?? null),
    );

    writeStorageConsent(true);
    window.dispatchEvent(
      new StorageEvent("storage", { key: STORAGE_CONSENT_KEY }),
    );
    expect(seen).toEqual([true]);

    // Another tab cleared the whole store: `key` is null and this key changed with it.
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(seen).toEqual([true, null]);

    // An unrelated key is ignored.
    window.dispatchEvent(
      new StorageEvent("storage", { key: "something-else" }),
    );
    expect(seen).toHaveLength(2);

    unsubscribe();
    window.dispatchEvent(
      new StorageEvent("storage", { key: STORAGE_CONSENT_KEY }),
    );
    expect(seen).toHaveLength(2);
  });
});
