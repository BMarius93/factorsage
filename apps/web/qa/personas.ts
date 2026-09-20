import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import {
  qaBrowserProfileDirectory,
  type TestPersona,
} from "@intrinsic/testing/personas";

import { qaPersona, repositoryRoot } from "../e2e/utils/env";
import {
  parseLauncherArguments,
  usage,
  UsageError,
  type LauncherOptions,
} from "./launcher-options";

/**
 * The manual multi-persona browser launcher (`pnpm qa:personas`).
 *
 * **Not a test.** It opens one visible, persistent, isolated browser per QA persona against an
 * already-running development stack and then gets out of the way: everything after that is a
 * person clicking. Nothing here asserts, and nothing here creates product content — building Lists,
 * Strategies, Monitors and Backtests by hand is the entire point.
 *
 * **Why a persistent context and not a storage-state file.** Playwright's `storageState` restores
 * cookies and `localStorage` into a fresh in-memory profile; `launchPersistentContext` opens a real
 * Chromium profile directory instead, so cookies, `localStorage`, `sessionStorage`, IndexedDB and
 * service workers all live on disk under that persona and nowhere else. Isolation is then a
 * property of the operating system rather than of this file remembering to clear something, and
 * persistence across relaunches comes for free. Incognito windows would give neither: they share a
 * profile with each other within one browser instance.
 *
 * **Authentication is the product's own sign-in form.** The launcher fills the same `/login` form a
 * customer does, with credentials from the repository-root `.env`, and only when the profile is not
 * already signed in. There is no test-only login route, no injected cookie and no bypass — so this
 * tool cannot weaken production authentication, because there is nothing to weaken.
 */

/** A visible window per persona, tiled so four of them do not land on top of each other. */
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 900;
const WINDOW_STAGGER = 48;

/**
 * Keeps `[FREE]`, `[STARTER]`, `[PRO]` or `[ADMIN]` in front of the browser tab's title.
 *
 * Injected into the page from outside the application, as an init script on this persona's context
 * only. The product's own `<title>` is untouched — nothing in `apps/web/src` knows this exists —
 * so there is no dev-only branch in the UI and nothing that could reach a real user. The observer
 * is needed because the App Router rewrites the title on every client-side navigation.
 */
function titleBadgeScript(label: string): string {
  return `(() => {
    const badge = ${JSON.stringify(`[${label}] `)};
    const apply = () => {
      if (typeof document.title === "string" && !document.title.startsWith(badge)) {
        document.title = badge + document.title;
      }
    };
    const watch = () => {
      apply();
      new MutationObserver(apply).observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    };
    if (document.head) {
      watch();
    } else {
      document.addEventListener("DOMContentLoaded", watch, { once: true });
    }
  })();`;
}

/** Signed in when the product's own account control is present; it renders only after `/auth/me`. */
async function isSignedIn(page: Page): Promise<boolean> {
  const trigger = page.getByTestId("account-menu-trigger").first();
  try {
    await trigger.waitFor({ state: "visible", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Signs this persona in through `/login`, exactly as a person would.
 *
 * Reached only when the persistent profile holds no usable session — the first launch, or after
 * the session was ended deliberately. The form is the one already on screen, so the `?next=`
 * the route gate added is preserved and the browser lands back on the requested route.
 */
async function signIn(page: Page, persona: TestPersona): Promise<void> {
  const credentials = qaPersona(persona.name);
  if (!page.url().includes("/login")) {
    await page.goto(`${new URL(page.url()).origin}/login`);
  }
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page
    .getByTestId("account-menu-trigger")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function openPersona(
  persona: TestPersona,
  options: LauncherOptions,
  index: number,
): Promise<BrowserContext> {
  const root = repositoryRoot() ?? process.cwd();
  const profileDirectory = resolve(
    join(root, qaBrowserProfileDirectory(persona)),
  );
  mkdirSync(profileDirectory, { recursive: true });

  const offset = index * WINDOW_STAGGER;
  const context = await chromium.launchPersistentContext(profileDirectory, {
    headless: false,
    // `viewport: null` lets the page fill whatever the person resizes the window to, which is what
    // makes DevTools responsive mode and manual resizing the way to inspect mobile layouts.
    viewport: null,
    args: [
      `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
      `--window-position=${offset},${offset}`,
    ],
  });
  await context.addInitScript(titleBadgeScript(persona.label));

  const page = context.pages()[0] ?? (await context.newPage());
  const target = `${options.baseUrl}${options.route}`;
  await page.goto(target, { waitUntil: "domcontentloaded" });

  if (!(await isSignedIn(page))) {
    console.log(
      `  ${persona.label}: signing in (first launch of this profile)…`,
    );
    await signIn(page, persona);
    if (!page.url().startsWith(target)) {
      await page.goto(target, { waitUntil: "domcontentloaded" });
    }
  }

  console.log(
    `  ${persona.label}: ${persona.plan}/${persona.role} on ${target} ` +
      `(profile ${qaBrowserProfileDirectory(persona)})`,
  );
  return context;
}

async function main(): Promise<void> {
  let options: LauncherOptions;
  try {
    options = parseLauncherArguments(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      if (error.message) {
        console.error(error.message);
        console.error("");
      }
      console.error(usage());
      process.exitCode = error.message ? 1 : 0;
      return;
    }
    throw error;
  }

  console.log(
    `Opening ${options.personas.length} QA persona window(s) on ${options.baseUrl}${options.route}:`,
  );

  const contexts: BrowserContext[] = [];
  // Sequentially: a first launch signs in through the real form, and the API rate-limits credential
  // endpoints per client IP. Four browsers racing that limit would fail in a way that looks like a
  // broken password.
  for (const [index, persona] of options.personas.entries()) {
    contexts.push(await openPersona(persona, options, index));
  }

  console.log(
    "\nWindows are open and sessions are isolated. Close every window to end this command; " +
      "profiles are kept, so the next launch is already signed in.",
  );

  await Promise.all(
    contexts.map(
      (context) =>
        new Promise<void>((resolveClosed) => {
          context.on("close", () => resolveClosed());
        }),
    ),
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`QA persona launcher failed: ${message}`);
  process.exitCode = 1;
});
