import { LEGAL_DISCLOSURES } from "@intrinsic/contracts";
import { expect, test } from "../fixtures";

/**
 * The contextual disclosures, on the surfaces they describe.
 *
 * Asserted against `LEGAL_DISCLOSURES` rather than against a copy of the sentence, because the
 * point of that constant is that there is exactly one wording per claim in the product. A spec
 * that restated the text would be the second source of truth it exists to prevent.
 */
test.describe("contextual disclosures", () => {
  test("the Dashboard says what a signal is, and links the full disclosure", async ({
    page,
  }) => {
    await page.goto("/");

    const note = page.getByTestId("disclosure-signals");
    await expect(note).toBeVisible();
    await expect(note).toContainText(LEGAL_DISCLOSURES.signals);
    // The short sentence is a summary of a document, and must be traceable to it.
    await note.getByRole("link", { name: "Read the Risk Disclosure" }).click();
    await expect(page).toHaveURL(/\/risk-disclosure$/);
  });

  test("a stock's intrinsic values are described as model estimates", async ({
    page,
  }) => {
    await page.goto("/stocks/QATEST1");

    const note = page.getByTestId("disclosure-valuations");
    await expect(note).toBeVisible();
    await expect(note).toContainText(LEGAL_DISCLOSURES.valuations);
  });

  test("the pricing page separates renewal, withdrawal and a faulty service", async ({
    page,
  }) => {
    await page.goto("/pricing");

    const panel = page.getByTestId("subscription-disclosure");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Cancelling a renewal");
    await expect(panel).toContainText("Statutory withdrawal");
    await expect(panel).toContainText("If the service is faulty");
    await expect(panel).toContainText(LEGAL_DISCLOSURES.subscription);

    // No blanket refusal, and no waiver at signup.
    await expect(panel).not.toContainText("no refunds");
    await expect(panel).not.toContainText("all sales are final");
  });
});
