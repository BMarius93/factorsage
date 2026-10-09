import {
  e2eDisposableAccountPattern,
  type E2eDisposableAccountKind,
} from "./e2e-accounts.js";
import { E2eMailBoundaryError, e2eMailpitApiUrl } from "./e2e-stack.js";

/**
 * The email lifecycle suite's view of the local Mailpit (`pnpm test:e2e:mail`).
 *
 * Mailpit is only the SMTP sink and the inbox observer: the application delivers to it through its
 * ordinary SMTP sender, and this reads what arrived, picks out the one message a spec caused, and
 * hands back the link in it. Written against Mailpit's API v1 as the pinned v1.31.4 serves it
 * (`scripts/cloud/lib.sh`), and only the parts read here:
 *
 * - `GET /api/v1/search?query=&start=&limit=` — newest first, paginated;
 * - `GET /api/v1/message/{ID}` — `To`/`Cc`/`Bcc`, `Subject`, `Text`, `HTML`;
 * - `DELETE /api/v1/messages` with `{ "IDs": [...] }`;
 * - `GET /api/v1/info` and `GET /api/v1/webui`, for the preflight.
 *
 * **Three things about that API decide how this is written:**
 *
 * 1. `to:` search is a case-insensitive *substring* match — `to:authmail-1@example.test` also
 *    returns `xauthmail-1@example.test` and `AUTHMAIL-1@EXAMPLE.TEST`. Search only narrows; every
 *    message is then kept or dropped by exact comparison of its full recipient list here.
 * 2. `DELETE /api/v1/messages` with no IDs deletes **every message in the mailbox**. Nothing here
 *    ever sends that request: an empty ID list is refused before a request exists, so a cleanup
 *    can only remove messages it has identified as its own.
 * 3. Mailpit can relay a message to a real SMTP server when it is configured to. The preflight
 *    refuses a Mailpit whose relay is enabled, and nothing here ever calls the release endpoint.
 *
 * Tokens never leave this module in an error message: every diagnostic carries the redacted form of
 * a link (`…/verify-email?token=[redacted]`), and the plaintext link is returned to the caller only
 * to navigate to.
 *
 * Deliberately free of workspace imports, like `./e2e-stack`: the Playwright harness reads it
 * through the `@intrinsic/testing/mailpit` subpath.
 */

export type MailpitAddress = {
  readonly Name: string;
  readonly Address: string;
};

/** One entry of a search result. */
export type MailpitMessageSummary = {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly MailpitAddress[] | null;
  readonly Cc: readonly MailpitAddress[] | null;
  readonly Bcc: readonly MailpitAddress[] | null;
  readonly Created: string;
};

/** One whole message. */
export type MailpitMessage = Omit<MailpitMessageSummary, "Created"> & {
  readonly Text: string;
  readonly HTML: string;
};

type SearchPage = {
  readonly messages: readonly MailpitMessageSummary[] | null;
  readonly messages_count: number;
};

/** Every recipient of a message, as written. */
export function mailpitRecipients(
  message: Pick<MailpitMessageSummary, "To" | "Cc" | "Bcc">,
): string[] {
  return [
    ...(message.To ?? []),
    ...(message.Cc ?? []),
    ...(message.Bcc ?? []),
  ].map((address) => address.Address);
}

/** Addressed to `recipient` and nobody else, compared exactly — never by Mailpit's search. */
export function isAddressedOnlyTo(
  message: Pick<MailpitMessageSummary, "To" | "Cc" | "Bcc">,
  recipient: string,
): boolean {
  const recipients = mailpitRecipients(message);
  return recipients.length === 1 && recipients[0] === recipient;
}

/**
 * Whether every recipient of a message is a disposable address of `kind`, so the message can only
 * have been caused by that kind's spec. A message with any other recipient is not test-owned.
 */
export function isOwnedByDisposableKind(
  message: Pick<MailpitMessageSummary, "To" | "Cc" | "Bcc">,
  kind: E2eDisposableAccountKind,
): boolean {
  const recipients = mailpitRecipients(message);
  const pattern = e2eDisposableAccountPattern(kind);
  return (
    recipients.length > 0 &&
    recipients.every((address) => pattern.test(address))
  );
}

/** A link with every query value replaced, safe to print. */
export function redactLink(raw: string): string {
  try {
    const url = new URL(raw);
    const keys = [...new Set(url.searchParams.keys())];
    return `${url.origin}${url.pathname}${keys.length === 0 ? "" : `?${keys.map((key) => `${key}=[redacted]`).join("&")}`}`;
  } catch {
    return "[unparseable link]";
  }
}

/** The single-use link an account email carries, and its printable form. */
export type EmailActionLink = {
  /** The plaintext link, token included. Navigate to it; never print or log it. */
  readonly href: string;
  /** The same link with its token replaced. */
  readonly redacted: string;
};

/** A token the application mints: 256 bits, base64url (`randomBytes(32).toString("base64url")`). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const LOOPBACK_WEB_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

function decodeHtmlAttribute(value: string): string {
  return value.replace(
    /&(amp|quot|#39|lt|gt);/g,
    (entity) => HTML_ENTITIES[entity]!,
  );
}

function parseable(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * The one `<origin><path>?token=…` link in an account email, checked before anyone navigates to it.
 *
 * Read from both bodies the application writes (`AuthEmailService`): every absolute URL in the
 * text part, every `href` in the HTML part. The link is accepted only when:
 *
 * - `expectedOrigin` is itself a loopback `http:` origin — the local FactorSage web app;
 * - the text part holds **exactly one** distinct link to that origin and path, and the HTML part's
 *   links to it are that same link — so a template that grew a second action link, or two bodies
 *   that disagree, fail here rather than navigating somewhere unexpected;
 * - its query is exactly one `token` in the shape the application mints, and nothing else.
 *
 * A link to any other origin is never returned. A refusal names the origins and paths it did find,
 * redacted, so a misconfigured `WEB_BASE_URL` is diagnosable without printing a token.
 */
export function extractActionLink(
  message: Pick<MailpitMessage, "Text" | "HTML">,
  expected: { readonly origin: string; readonly path: string },
): EmailActionLink {
  const origin = parseable(expected.origin);
  if (
    origin === null ||
    origin.protocol !== "http:" ||
    !LOOPBACK_WEB_HOSTS.has(origin.hostname) ||
    origin.origin !== expected.origin.replace(/\/$/, "")
  ) {
    throw new E2eMailBoundaryError(
      `Refusing to follow email links to ${expected.origin}: the E2E suite only ever navigates to ` +
        "the local FactorSage web app on a loopback http origin.",
    );
  }

  const fromText = [...message.Text.matchAll(/https?:\/\/[^\s<>"']+/g)].map(
    (match) => match[0],
  );
  const fromHtml = [...message.HTML.matchAll(/href\s*=\s*"([^"]*)"/gi)].map(
    (match) => decodeHtmlAttribute(match[1]!),
  );
  const targets = (links: readonly string[]) => [
    ...new Set(
      links.filter((link) => {
        const url = parseable(link);
        return (
          url !== null &&
          url.origin === origin.origin &&
          url.pathname === expected.path
        );
      }),
    ),
  ];

  const textTargets = targets(fromText);
  const htmlTargets = targets(fromHtml);
  const wanted = `${origin.origin}${expected.path}`;
  if (textTargets.length !== 1) {
    const found = [...new Set([...fromText, ...fromHtml].map(redactLink))];
    throw new E2eMailBoundaryError(
      `Expected exactly one ${wanted} link in the message text, found ${textTargets.length}. ` +
        `Links present: ${found.length === 0 ? "none" : found.join(", ")}.`,
    );
  }
  const href = textTargets[0]!;
  const redacted = redactLink(href);
  if (htmlTargets.length !== 1 || htmlTargets[0] !== href) {
    throw new E2eMailBoundaryError(
      `The message's HTML part does not carry the same ${wanted} link as its text part ` +
        `(${redacted}).`,
    );
  }

  const url = new URL(href);
  const keys = [...url.searchParams.keys()];
  const token = url.searchParams.get("token");
  if (
    keys.length !== 1 ||
    keys[0] !== "token" ||
    token === null ||
    !TOKEN.test(token) ||
    url.hash !== ""
  ) {
    throw new E2eMailBoundaryError(
      `The ${wanted} link is not a single token in the shape the application mints (${redacted}).`,
    );
  }
  return { href, redacted };
}

export type MailpitFetch = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export type WaitForMessageOptions = {
  readonly to: string;
  readonly subject: string;
  /** Bounded: the wait fails after this long. Default 20 s. */
  readonly timeoutMs?: number;
  /** Fixed interval between polls. Default 250 ms. */
  readonly pollMs?: number;
};

const PAGE_SIZE = 200;

/**
 * A client of the local Mailpit's HTTP API, and nothing else: the base URL comes from
 * `e2eMailpitApiUrl`, which refuses any origin that is not loopback, so there is no way to point
 * one at another host.
 */
export class MailpitClient {
  readonly baseUrl: string;
  private readonly fetchImpl: MailpitFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    env: Readonly<Record<string, string | undefined>> = process.env,
    /** Replaced only by this client's own tests. */
    seams: {
      readonly fetch?: MailpitFetch;
      readonly sleep?: (ms: number) => Promise<void>;
      readonly now?: () => number;
    } = {},
  ) {
    this.baseUrl = e2eMailpitApiUrl(env);
    this.fetchImpl = seams.fetch ?? ((input, init) => fetch(input, init));
    this.sleep =
      seams.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = seams.now ?? Date.now;
  }

  /**
   * Proves this is a reachable Mailpit that cannot forward anything: its info endpoint answers with
   * a version, and message relay — the one feature that could send a captured message to a real
   * SMTP server — is off.
   */
  async preflight(): Promise<{ readonly version: string }> {
    const info = (await this.get("/api/v1/info")) as { Version?: unknown };
    if (typeof info.Version !== "string" || info.Version === "") {
      throw new E2eMailBoundaryError(
        `${this.baseUrl} answered, but not as Mailpit (no version in /api/v1/info).`,
      );
    }
    const webui = (await this.get("/api/v1/webui")) as {
      MessageRelay?: { Enabled?: unknown };
    };
    if (webui.MessageRelay?.Enabled !== false) {
      throw new E2eMailBoundaryError(
        `The Mailpit at ${this.baseUrl} has message relay enabled (or does not say), so a ` +
          "captured message could be forwarded to a real SMTP server. Start it without " +
          "--smtp-relay-config, as scripts/cloud/lib.sh does.",
      );
    }
    return { version: info.Version };
  }

  /** Every message addressed to `recipient` alone, newest first. */
  async messagesTo(recipient: string): Promise<MailpitMessageSummary[]> {
    return (await this.search(`to:"${recipient}"`)).filter((message) =>
      isAddressedOnlyTo(message, recipient),
    );
  }

  /**
   * Waits for the one message with this subject sent to this recipient alone, and returns it whole.
   *
   * Polls at a fixed interval up to a fixed deadline. The match is exact on recipient and subject
   * and independent of the inbox's order or anything else in it. More than one match fails: the
   * suite's recipients are unique per run and the application sends one message per request, so a
   * second one means something sent twice.
   */
  async waitForMessage(
    options: WaitForMessageOptions,
  ): Promise<MailpitMessage> {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const pollMs = options.pollMs ?? 250;
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const matches = (await this.messagesTo(options.to)).filter(
        (message) => message.Subject === options.subject,
      );
      if (matches.length > 1) {
        throw new E2eMailBoundaryError(
          `Expected one "${options.subject}" message to ${options.to}, found ${matches.length}.`,
        );
      }
      if (matches.length === 1) {
        const message = (await this.get(
          `/api/v1/message/${encodeURIComponent(matches[0]!.ID)}`,
        )) as MailpitMessage;
        if (!isAddressedOnlyTo(message, options.to)) {
          throw new E2eMailBoundaryError(
            `Message ${matches[0]!.ID} is not addressed to ${options.to} alone.`,
          );
        }
        return message;
      }
      if (this.now() >= deadline) {
        throw new E2eMailBoundaryError(
          `No "${options.subject}" message reached Mailpit for ${options.to} within ${timeoutMs} ms. ` +
            "Is the API running in mail mode (pnpm dev:api:e2e:mail)?",
        );
      }
      await this.sleep(pollMs);
    }
  }

  /**
   * Deletes exactly these messages. An empty list is refused before any request is made: Mailpit
   * reads `DELETE /api/v1/messages` without IDs as "delete every message".
   */
  async deleteMessages(ids: readonly string[]): Promise<void> {
    if (
      ids.length === 0 ||
      ids.some((id) => typeof id !== "string" || id === "")
    ) {
      throw new E2eMailBoundaryError(
        "Refusing to delete Mailpit messages without explicit IDs: Mailpit would delete the whole mailbox.",
      );
    }
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/messages`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ IDs: ids }),
    });
    if (!response.ok) {
      throw new E2eMailBoundaryError(
        `Mailpit refused to delete ${ids.length} message(s): HTTP ${response.status}.`,
      );
    }
  }

  /** Deletes the messages addressed to `recipient` alone, and returns how many. */
  async deleteMessagesTo(recipient: string): Promise<number> {
    const ids = (await this.messagesTo(recipient)).map((message) => message.ID);
    if (ids.length > 0) {
      await this.deleteMessages(ids);
    }
    return ids.length;
  }

  /** The messages every recipient of which is a disposable address of `kind`. */
  async messagesOwnedBy(
    kind: E2eDisposableAccountKind,
  ): Promise<MailpitMessageSummary[]> {
    return (await this.search(`to:"${kind}-"`)).filter((message) =>
      isOwnedByDisposableKind(message, kind),
    );
  }

  /**
   * Deletes every message a `kind` spec caused — what an interrupted run left, or what a finished
   * one did not remove — and nothing else, and returns how many.
   */
  async sweepDisposableKind(kind: E2eDisposableAccountKind): Promise<number> {
    const ids = (await this.messagesOwnedBy(kind)).map((message) => message.ID);
    if (ids.length > 0) {
      await this.deleteMessages(ids);
    }
    return ids.length;
  }

  private async search(query: string): Promise<MailpitMessageSummary[]> {
    const found: MailpitMessageSummary[] = [];
    for (let start = 0; ; start += PAGE_SIZE) {
      const page = (await this.get(
        `/api/v1/search?${new URLSearchParams({ query, start: String(start), limit: String(PAGE_SIZE) })}`,
      )) as SearchPage;
      const messages = page.messages ?? [];
      found.push(...messages);
      if (messages.length < PAGE_SIZE || found.length >= page.messages_count) {
        return found;
      }
    }
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`);
    if (!response.ok) {
      throw new E2eMailBoundaryError(
        `Mailpit answered HTTP ${response.status} to ${path.split("?")[0]}.`,
      );
    }
    return response.json();
  }
}
