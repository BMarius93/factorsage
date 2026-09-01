import { test as setup } from "@playwright/test";
import { STORAGE_STATE, qaPersona } from "../utils/env";
import { signInThroughUi } from "../utils/sign-in";

/**
 * Signs each persistent QA persona in once and saves its storage state.
 *
 * The state files are git-ignored: they contain a live session cookie and must never be
 * committed.
 */
setup("authenticate QA_USER", async ({ page }) => {
  await signInThroughUi(page, qaPersona("QA_USER"));
  await page.context().storageState({ path: STORAGE_STATE.QA_USER });
});

setup("authenticate QA_ADMIN", async ({ page }) => {
  await signInThroughUi(page, qaPersona("QA_ADMIN"));
  await page.context().storageState({ path: STORAGE_STATE.QA_ADMIN });
});
