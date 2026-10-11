import type {
  AlternativeDataActorResponse,
  StrategyDetailResponse,
} from "@intrinsic/contracts";
import { QA_CONGRESS_MEMBERS } from "@intrinsic/testing/qa-congress-members";
import { expect, test, type Locator, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import { chooseFromOverflowMenu } from "../utils/overflow-menu";
import { chooseMetric } from "../utils/strategy-builder";

/**
 * Selecting members of Congress inside a Congressional Trading rule, for PRO_USER.
 *
 * What only a browser against the real API can prove: that the members a user picks are the ids the
 * strategy stores, that the names read the same on the row, in the Strategy Logic panel and in a
 * reopened dialog, and that saving, reloading, editing and duplicating the strategy keeps exactly
 * that selection. It also covers what replaced: there is no Congress groups view anywhere, and the
 * old links to one land on the stock lists.
 *
 * Precondition beyond the usual stack: `pnpm test:securities:seed`, which writes the three fictional
 * members this spec selects (`QA_CONGRESS_MEMBERS`). The hermetic stack ingests no disclosure, so
 * they are the whole catalog here — and nothing in this spec needs them to have traded.
 */

const { HOUSE, SENATE, ALIAS } = QA_CONGRESS_MEMBERS;

function strategyIdOf(page: Page): string {
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

async function readStrategy(
  page: Page,
  strategyId: string,
): Promise<StrategyDetailResponse> {
  const response = await page.request.get(
    `${apiBaseUrl()}/strategies/${strategyId}`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as StrategyDetailResponse;
}

/** The catalog ids of the fixture members, by the external identity the seeder gave them. */
async function memberIds(page: Page): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const member of [HOUSE, SENATE, ALIAS]) {
    const response = await page.request.get(
      `${apiBaseUrl()}/alternative-data/actors?q=${encodeURIComponent(member.externalId)}`,
    );
    expect(response.ok()).toBe(true);
    const [found] = (await response.json()) as AlternativeDataActorResponse[];
    expect(
      found,
      `${member.displayName} is not in the catalog — run pnpm test:securities:seed`,
    ).toBeDefined();
    ids[member.externalId] = (found as AlternativeDataActorResponse).id;
  }
  return ids;
}

/** Best-effort teardown, so a failure cannot leave PRO_USER accumulating strategies. */
async function deleteStrategies(page: Page, ids: readonly (string | null)[]) {
  for (const id of ids) {
    if (id) {
      await page.request
        .delete(`${apiBaseUrl()}/strategies/${id}`)
        .catch(() => {});
    }
  }
}

function firstRow(page: Page): Locator {
  return page
    .getByTestId("level-card-BUY")
    .first()
    .getByTestId("predicate-row")
    .first();
}

function scopeOf(strategy: StrategyDetailResponse, condition = 0): unknown {
  const metric =
    strategy.definition.buyLevels[0]?.signal.conditions[condition]?.metric;
  return metric?.kind === "CONGRESS_ACTIVITY" ? metric.scope : undefined;
}

async function openConfiguration(page: Page, row: Locator): Promise<Locator> {
  await row.getByTestId("operand-config-button").click();
  const dialog = page.getByTestId("alternative-data-config");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Searches the way a user does — typing — and picks the row the catalog answers with. */
async function pickMember(
  dialog: Locator,
  term: string,
  member: { displayName: string; meta: string },
): Promise<void> {
  await dialog.getByLabel("Search members of Congress").fill(term);
  const option = dialog
    .getByRole("option")
    .filter({ hasText: member.displayName });
  await expect(option).toHaveCount(1);
  // The seat beside the name is what tells two members apart, and one spelling from another.
  await expect(option).toContainText(member.meta);
  await option.click();
}

function chips(dialog: Locator): Locator {
  return dialog.getByTestId("actor-chip");
}

async function apply(dialog: Locator): Promise<void> {
  await dialog.getByTestId("alternative-data-config-apply").click();
  await expect(dialog).toHaveCount(0);
}

test.describe("selecting members of Congress in a rule", () => {
  test("stores the members picked, and keeps them through save, reload, edit and duplicate", async ({
    page,
  }) => {
    const ids = await memberIds(page);
    const name = `E2E congress members ${Date.now()}`;
    let sourceId: string | null = null;
    let copyId: string | null = null;
    try {
      await page.goto("/strategies/new");
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByTestId("add-level-BUY").click();
      const row = firstRow(page);
      await chooseMetric(
        row,
        "CONGRESSIONAL_TRADING",
        "CONGRESS_ACTIVITY:BUYERS",
      );

      const dialog = await openConfiguration(page, row);
      // Anyone, or the members selected here. No group, and no single-member picker.
      await expect(dialog.getByRole("radio")).toHaveCount(2);
      await expect(dialog.getByRole("radio", { name: "Anyone" })).toBeChecked();
      await dialog.getByRole("radio", { name: "Selected members" }).check();
      // A selection of nobody is not a rule, so it cannot be applied.
      await expect(
        dialog.getByTestId("alternative-data-config-apply"),
      ).toBeDisabled();
      await expect(dialog.getByTestId("alt-actor-count")).toContainText(
        "Select at least one member.",
      );
      // The catalog is honest about not being every member.
      await expect(dialog.getByTestId("alt-actor-count")).toContainText(
        "it is not every member of Congress",
      );

      await pickMember(dialog, "Fairweather", SENATE);
      await pickMember(dialog, "Aldersgate", HOUSE);
      await expect(chips(dialog)).toHaveText([
        `${HOUSE.displayName}×`,
        `${SENATE.displayName}×`,
      ]);
      await expect(dialog.getByTestId("alt-actor-count")).toContainText(
        "2 of 250 selected.",
      );
      // The chosen members stay put while the search moves on to somebody else.
      await dialog
        .getByLabel("Search members of Congress")
        .fill("Winterbourne");
      await expect(
        dialog.getByRole("option").filter({ hasText: ALIAS.displayName }),
      ).toHaveCount(1);
      await expect(chips(dialog)).toHaveCount(2);
      await dialog.getByLabel("Search members of Congress").fill("");
      await apply(dialog);

      const both = `30D · ${HOUSE.displayName}, ${SENATE.displayName}`;
      await expect(row.getByTestId("operand-configuration-summary")).toHaveText(
        both,
      );
      await expect(page.getByTestId("logic-preview")).toContainText(
        `Congress buyers is above 0 (${both})`,
      );

      await page.getByTestId("save-strategy").click();
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
      sourceId = strategyIdOf(page);
      // The rule holds the members' ids — never their names — in canonical order.
      expect(scopeOf(await readStrategy(page, sourceId))).toEqual({
        kind: "ACTORS",
        actorIds: [ids[HOUSE.externalId], ids[SENATE.externalId]].sort(),
      });

      // Reload: the names come back from the ids.
      await page.reload();
      await expect(
        firstRow(page).getByTestId("operand-configuration-summary"),
      ).toHaveText(both);
      await expect(page.getByTestId("save-strategy")).toBeDisabled();

      // Reopen the saved rule: every saved member is there to edit.
      const reopened = await openConfiguration(page, firstRow(page));
      await expect(
        reopened.getByRole("radio", { name: "Selected members" }),
      ).toBeChecked();
      await expect(chips(reopened)).toHaveText([
        `${HOUSE.displayName}×`,
        `${SENATE.displayName}×`,
      ]);
      // Remove one, and add one found by the name people use rather than the one the catalog holds.
      await reopened
        .getByRole("button", { name: `Remove ${SENATE.displayName}` })
        .click();
      await expect(chips(reopened)).toHaveCount(1);
      await pickMember(reopened, ALIAS.familiarName, ALIAS);
      await expect(chips(reopened)).toHaveCount(2);
      await apply(reopened);

      const edited = `30D · ${ALIAS.displayName}, ${HOUSE.displayName}`;
      await expect(
        firstRow(page).getByTestId("operand-configuration-summary"),
      ).toHaveText(edited);
      await page.getByTestId("save-strategy").click();
      await expect(page.getByText("All changes saved")).toBeVisible();
      const afterEdit = await readStrategy(page, sourceId);
      // A different selection is different logic: a new version, of the same rule.
      expect(afterEdit.versionNumber).toBe(2);
      expect(scopeOf(afterEdit)).toEqual({
        kind: "ACTORS",
        actorIds: [ids[ALIAS.externalId], ids[HOUSE.externalId]].sort(),
      });

      // Duplicate from the collection: the copy selects the same members.
      await page.goto("/strategies");
      const collectionRow = page
        .getByTestId("strategies-grid")
        .locator("tbody tr")
        .filter({ hasText: name });
      await chooseFromOverflowMenu(page, name, "Duplicate", collectionRow);
      const duplicate = page.getByTestId("duplicate-dialog");
      await duplicate.getByLabel("Name").fill(`${name} (copy)`);
      await duplicate.getByLabel("Name").press("Enter");
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/, {
        timeout: 20_000,
      });
      copyId = strategyIdOf(page);
      expect(copyId).not.toBe(sourceId);
      await expect(
        firstRow(page).getByTestId("operand-configuration-summary"),
      ).toHaveText(edited);
      expect(scopeOf(await readStrategy(page, copyId))).toEqual(
        scopeOf(afterEdit),
      );
    } finally {
      await deleteStrategies(page, [copyId, sourceId]);
    }
  });

  test("gives two rules of one metric their own selections", async ({
    page,
  }) => {
    const ids = await memberIds(page);
    const name = `E2E congress two rules ${Date.now()}`;
    let id: string | null = null;
    try {
      await page.goto("/strategies/new");
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByTestId("add-level-BUY").click();
      const level = page.getByTestId("level-card-BUY").first();
      await level.getByRole("button", { name: /add condition/i }).click();
      const rows = level.getByTestId("predicate-row");
      await expect(rows).toHaveCount(2);

      for (const [index, member, term] of [
        [0, HOUSE, "Aldersgate"],
        [1, SENATE, "Fairweather"],
      ] as const) {
        const row = rows.nth(index);
        await chooseMetric(
          row,
          "CONGRESSIONAL_TRADING",
          "CONGRESS_ACTIVITY:PURCHASES",
        );
        const dialog = await openConfiguration(page, row);
        await dialog.getByRole("radio", { name: "Selected members" }).check();
        // Each rule opens on its own selection: the second does not inherit the first's.
        await expect(chips(dialog)).toHaveCount(0);
        await pickMember(dialog, term, member);
        await apply(dialog);
        await expect(
          row.getByTestId("operand-configuration-summary"),
        ).toHaveText(`30D · ${member.displayName}`);
      }
      // The first rule is as it was after the second was configured.
      await expect(
        rows.nth(0).getByTestId("operand-configuration-summary"),
      ).toHaveText(`30D · ${HOUSE.displayName}`);

      await page.getByTestId("save-strategy").click();
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
      id = strategyIdOf(page);
      const saved = await readStrategy(page, id);
      expect(scopeOf(saved, 0)).toEqual({
        kind: "ACTORS",
        actorIds: [ids[HOUSE.externalId]],
      });
      expect(scopeOf(saved, 1)).toEqual({
        kind: "ACTORS",
        actorIds: [ids[SENATE.externalId]],
      });
    } finally {
      await deleteStrategies(page, [id]);
    }
  });
});

test.describe("Congress groups are gone from the Lists area", () => {
  test("shows stock lists and no Congress groups view", async ({ page }) => {
    await page.goto("/lists");
    await expect(page.getByTestId("lists-page")).toBeVisible();
    await expect(page.getByTestId("new-list-button")).toBeVisible();
    await expect(page.getByTestId("lists-view")).toHaveCount(0);
    await expect(page.getByText(/congress/i)).toHaveCount(0);
    await expect(
      page.getByText(
        "Reusable stock universes for strategies, backtests, and monitors.",
      ),
    ).toBeVisible();
  });

  test("lands an old Congress groups link on the stock lists", async ({
    page,
  }) => {
    await page.goto("/lists?view=congress");
    await expect(page.getByTestId("lists-page")).toBeVisible();
    await expect(page.getByTestId("new-list-button")).toBeVisible();
    // The dead parameter is dropped, so the address says what the page is.
    await expect(page).toHaveURL(/\/lists$/);
    await expect(page.getByText(/congress/i)).toHaveCount(0);
  });

  test("lands an old link to one group on the stock lists", async ({
    page,
  }) => {
    await page.goto("/lists/actor-groups/6f1b0a1e-8a6c-4c1a-9f0e-2b6c4d8e1a33");
    await expect(page).toHaveURL(/\/lists$/);
    await expect(page.getByTestId("lists-page")).toBeVisible();
  });
});
