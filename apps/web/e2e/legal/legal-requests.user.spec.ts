import { expect, test } from "../fixtures";

/**
 * The request channels, as the signed-in PRO persona.
 *
 * What is proved here is the shape the consumer rules ask a withdrawal function to have — the
 * contract identified, a review step, a confirmation, and an immediate durable receipt — and the
 * boundary the implementation deliberately keeps: the receipt acknowledges receipt and says so,
 * and nothing about submitting it moves money or changes a subscription.
 */
test.describe("legal request channels", () => {
  test("a withdrawal request is reviewed, confirmed, and receipted", async ({
    page,
  }) => {
    await page.goto("/cancellation-and-refunds");

    // The contract the request is about, read from live billing state.
    await expect(page.getByTestId("withdrawal-subscription")).toBeVisible();

    const form = page.getByTestId("legal-request-form-withdrawal");
    await expect(form).toBeVisible();
    await form
      .getByRole("textbox")
      .fill("E2E: withdrawing from my FactorSage subscription.");
    await form
      .getByRole("button", { name: "Review withdrawal request" })
      .click();

    // A review step, before anything is sent, showing exactly what will be.
    const review = page.getByTestId("legal-request-review");
    await expect(review).toBeVisible();
    await expect(review).toContainText(
      "E2E: withdrawing from my FactorSage subscription.",
    );
    await page.getByTestId("legal-request-confirm").click();

    // The receipt replaces the form in place; the account's request history below renders
    // receipts of its own, so the new one is addressed as the first.
    const receipt = page.getByTestId("legal-request-receipt").first();
    await expect(receipt).toBeVisible();
    await expect(receipt.getByTestId("receipt-reference")).toHaveText(/\S/);
    await expect(receipt.getByTestId("receipt-submitted-at")).toHaveText(/\S/);
    // A receipt is an acknowledgment of receipt, and never a decision.
    await expect(receipt).toContainText("not a decision on the request");
    await expect(receipt.getByTestId("receipt-download")).toBeVisible();
  });

  test("a privacy request appears in the account's own history afterwards", async ({
    page,
  }) => {
    await page.goto("/legal/requests");

    const form = page.getByTestId("legal-request-form-privacy_request");
    await form
      .getByRole("textbox")
      .fill("E2E: please send me a copy of my personal data.");
    await form.getByRole("button", { name: "Review privacy request" }).click();
    await page.getByTestId("legal-request-confirm").click();

    const reference = await page
      .getByTestId("legal-request-receipt")
      .first()
      .getByTestId("receipt-reference")
      .textContent();
    expect(reference?.trim()).toBeTruthy();

    // The third way a receipt stays durable: it can be found again from the account.
    await page.reload();
    const history = page.getByTestId("legal-request-history");
    await expect(history).toBeVisible();
    await expect(history).toContainText(reference?.trim() ?? "");
  });

  test("cancelling a renewal is kept separate from withdrawing", async ({
    page,
  }) => {
    await page.goto("/cancellation-and-refunds");

    // The page says the two are different, and sends a renewal cancellation to Billing rather
    // than offering a second control here that looks like one.
    const subscription = page.getByTestId("withdrawal-subscription");
    await expect(subscription).toContainText(
      "Cancelling a renewal is not a withdrawal",
    );
    await subscription
      .getByRole("link", { name: "Manage or cancel your subscription" })
      .click();
    await expect(page).toHaveURL(/\/billing$/);
  });
});
