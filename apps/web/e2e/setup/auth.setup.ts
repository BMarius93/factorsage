import { test as setup } from "@playwright/test";
import { TEST_PERSONA_NAMES } from "@intrinsic/testing/personas";
import { STORAGE_STATE, qaPersona } from "../utils/env";
import { signInThroughUi } from "../utils/sign-in";

/**
 * Signs each persistent persona in once and saves its storage state.
 *
 * Driven by the shared registry rather than a list here, so adding a persona cannot leave one
 * without a session. The state files are git-ignored: they contain a live session cookie and must
 * never be committed.
 */
for (const name of TEST_PERSONA_NAMES) {
  setup(`authenticate ${name}`, async ({ page }) => {
    await signInThroughUi(page, qaPersona(name));
    await page.context().storageState({ path: STORAGE_STATE[name] });
  });
}
