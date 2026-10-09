import { randomBytes } from "node:crypto";
import { getAuthConfig } from "@intrinsic/config";
import {
  E2eMailBoundaryError,
  MailpitClient,
  extractActionLink,
  isAddressedOnlyTo,
  isOwnedByDisposableKind,
  redactLink,
  type MailpitAddress,
  type MailpitFetch,
  type MailpitMessage,
} from "@intrinsic/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthEmailService } from "../auth/auth-email.service";
import { InMemoryEmailSender } from "../email/in-memory-email-sender";
import type { EmailMessage } from "../email/email-sender";

/**
 * The email lifecycle suite's Mailpit client (`@intrinsic/testing/mailpit`): which message it picks,
 * which link it follows, and what it may delete. The live run against a real Mailpit is
 * `apps/web/e2e/auth/email-lifecycle.mail.spec.ts`.
 */

const WEB_ORIGIN = "http://localhost:3000";

/** The application's real account emails, rendered by the real `AuthEmailService`. */
function accountEmails() {
  const sender = new InMemoryEmailSender();
  const service = new AuthEmailService(
    sender,
    getAuthConfig({
      AUTH_JWT_SECRET: "e2e-mailpit-test-secret-of-sufficient-length",
      WEB_BASE_URL: WEB_ORIGIN,
    }),
  );
  return { sender, service };
}

/** A token in the shape the application mints. */
function token(): string {
  return randomBytes(32).toString("base64url");
}

function asMailpit(
  message: EmailMessage,
): Pick<MailpitMessage, "Text" | "HTML"> {
  return { Text: message.text, HTML: message.html };
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(E2eMailBoundaryError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("extractActionLink against the application's own emails", () => {
  it("reads the activation link out of the real verification email", async () => {
    const { sender, service } = accountEmails();
    const secret = token();
    await service.sendVerificationEmail({
      to: "authmail-1@example.test",
      token: secret,
    });

    const link = extractActionLink(asMailpit(sender.lastMessage!), {
      origin: WEB_ORIGIN,
      path: "/verify-email",
    });
    expect(link.href).toBe(`${WEB_ORIGIN}/verify-email?token=${secret}`);
    expect(link.redacted).toBe(`${WEB_ORIGIN}/verify-email?token=[redacted]`);
    expect(link.redacted).not.toContain(secret);
  });

  it("reads the reset link out of the real password-reset email", async () => {
    const { sender, service } = accountEmails();
    const secret = token();
    await service.sendPasswordResetEmail({
      to: "authmail-1@example.test",
      token: secret,
    });

    expect(
      extractActionLink(asMailpit(sender.lastMessage!), {
        origin: WEB_ORIGIN,
        path: "/reset-password",
      }).href,
    ).toBe(`${WEB_ORIGIN}/reset-password?token=${secret}`);
  });

  it("finds no action link in the existing-account notice, which carries none", async () => {
    const { sender, service } = accountEmails();
    await service.sendExistingAccountNotice({
      to: "authmail-1@example.test",
      methods: { password: true, google: false },
    });
    const message = asMailpit(sender.lastMessage!);

    for (const path of ["/verify-email", "/reset-password"]) {
      expect(
        refusal(() => extractActionLink(message, { origin: WEB_ORIGIN, path })),
      ).toMatch(/Expected exactly one .* found 0/);
    }
  });

  it("does not take a verification link for a reset link, or the reverse", async () => {
    const { sender, service } = accountEmails();
    await service.sendVerificationEmail({
      to: "authmail-1@example.test",
      token: token(),
    });
    expect(
      refusal(() =>
        extractActionLink(asMailpit(sender.lastMessage!), {
          origin: WEB_ORIGIN,
          path: "/reset-password",
        }),
      ),
    ).toMatch(/found 0/);
  });
});

describe("extractActionLink refusals", () => {
  const secret = token();
  const good = `${WEB_ORIGIN}/verify-email?token=${secret}`;
  const message = (text: string, html = `<a href="${good}">${good}</a>`) => ({
    Text: text,
    HTML: html,
  });

  it("refuses to follow anything to a non-loopback or non-http origin", () => {
    for (const origin of [
      "https://factorsage.com",
      "http://factorsage.com",
      "https://localhost:3000",
      "http://localhost.evil.example:3000",
      "http://10.0.0.5:3000",
      "not a url",
    ]) {
      expect(
        refusal(() =>
          extractActionLink(message(good), { origin, path: "/verify-email" }),
        ),
      ).toMatch(/only ever navigates to the local FactorSage web app/);
    }
  });

  it("refuses a link to another origin, naming what it found without the token", () => {
    const elsewhere = `http://127.0.0.1:3000/verify-email?token=${secret}`;
    const reason = refusal(() =>
      extractActionLink(message(elsewhere, `<a href="${elsewhere}">x</a>`), {
        origin: WEB_ORIGIN,
        path: "/verify-email",
      }),
    );
    expect(reason).toMatch(/found 0/);
    expect(reason).toContain(
      "http://127.0.0.1:3000/verify-email?token=[redacted]",
    );
    expect(reason).not.toContain(secret);
  });

  it("refuses two different action links", () => {
    const other = `${WEB_ORIGIN}/verify-email?token=${token()}`;
    const reason = refusal(() =>
      extractActionLink(message(`${good}\n${other}`), {
        origin: WEB_ORIGIN,
        path: "/verify-email",
      }),
    );
    expect(reason).toMatch(/found 2/);
    expect(reason).not.toContain(secret);
  });

  it("refuses an HTML part that disagrees with the text part", () => {
    const other = `${WEB_ORIGIN}/verify-email?token=${token()}`;
    for (const html of [`<a href="${other}">${other}</a>`, "<p>no link</p>"]) {
      expect(
        refusal(() =>
          extractActionLink(message(good, html), {
            origin: WEB_ORIGIN,
            path: "/verify-email",
          }),
        ),
      ).toMatch(/HTML part does not carry the same/);
    }
  });

  it.each([
    ["a short token", `${WEB_ORIGIN}/verify-email?token=abc`],
    [
      "a token outside base64url",
      `${WEB_ORIGIN}/verify-email?token=${"a".repeat(42)}%2B`,
    ],
    ["a second parameter", `${good}&next=%2Fadmin`],
    ["a repeated token", `${good}&token=${secret}`],
    ["a fragment", `${good}#x`],
  ])("refuses %s", (_label, link) => {
    // The HTML part escapes `&` as the template's HTML would; it must still read as the same link,
    // so the refusal below is about the token, not a text/HTML mismatch.
    const reason = refusal(() =>
      extractActionLink(
        message(link, `<a href="${link.replaceAll("&", "&amp;")}">x</a>`),
        {
          origin: WEB_ORIGIN,
          path: "/verify-email",
        },
      ),
    );
    expect(reason).toMatch(/not a single token/);
    expect(reason).not.toContain(secret);
  });

  it("redacts every query value of a printed link", () => {
    expect(redactLink(`${good}&next=%2Fadmin`)).toBe(
      `${WEB_ORIGIN}/verify-email?token=[redacted]&next=[redacted]`,
    );
    expect(redactLink("::not a url::")).toBe("[unparseable link]");
  });
});

describe("message ownership", () => {
  const to = (...addresses: string[]): MailpitAddress[] =>
    addresses.map((Address) => ({ Name: "", Address }));
  const message = (
    To: MailpitAddress[],
    Cc: MailpitAddress[] = [],
    Bcc: MailpitAddress[] = [],
  ) => ({ To, Cc, Bcc });

  it("matches a recipient exactly, never as Mailpit's substring search does", () => {
    const recipient = "authmail-123@example.test";
    expect(isAddressedOnlyTo(message(to(recipient)), recipient)).toBe(true);
    for (const other of [
      message(to("xauthmail-123@example.test")),
      message(to("Authmail-123@Example.test")),
      message(to("authmail-1234@example.test")),
      message(to(recipient, "someone@example.test")),
      message(to(recipient), to("someone@example.test")),
      message(to(recipient), [], to("someone@example.test")),
      message([]),
    ]) {
      expect(isAddressedOnlyTo(other, recipient)).toBe(false);
    }
  });

  it("owns a message only when every recipient is a disposable address of the kind", () => {
    expect(
      isOwnedByDisposableKind(
        message(to("authmail-1@example.test", "authmail-2@example.test")),
        "authmail",
      ),
    ).toBe(true);
    for (const other of [
      message(to("escalation-1@example.test")),
      message(to("authmail-1@example.test", "person@example.com")),
      message(to("authmail-1@example.test"), to("person@example.com")),
      message(to("xauthmail-1@example.test")),
      message(to("authmail-1@example.test.evil")),
      message([]),
    ]) {
      expect(isOwnedByDisposableKind(other, "authmail")).toBe(false);
    }
  });
});

/**
 * A Mailpit with just the endpoints the client reads, holding messages in memory and recording
 * every request — including the one request that must never be made, a delete without IDs.
 */
class FakeMailpit {
  readonly messages: (MailpitMessage & { Created: string })[] = [];
  readonly requests: { method: string; path: string; body?: unknown }[] = [];
  relayEnabled = false;
  private sequence = 0;

  add(
    recipients: string[],
    subject: string,
    extra: Partial<MailpitMessage> = {},
  ): string {
    const ID = `msg${(this.sequence += 1).toString().padStart(4, "0")}`;
    this.messages.unshift({
      ID,
      Subject: subject,
      To: recipients.map((Address) => ({ Name: "", Address })),
      Cc: [],
      Bcc: [],
      Text: "",
      HTML: "",
      Created: new Date(1_800_000_000_000 + this.sequence).toISOString(),
      ...extra,
    });
    return ID;
  }

  readonly fetch: MailpitFetch = (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    this.requests.push({
      method,
      path: url.pathname,
      ...(body ? { body } : {}),
    });
    const reply = (status: number, value: unknown = {}) =>
      Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(value),
      });

    if (method === "GET" && url.pathname === "/api/v1/info") {
      return reply(200, { Version: "v1.31.4" });
    }
    if (method === "GET" && url.pathname === "/api/v1/webui") {
      return reply(200, { MessageRelay: { Enabled: this.relayEnabled } });
    }
    if (method === "GET" && url.pathname === "/api/v1/search") {
      // Mailpit's `to:` filter: a case-insensitive substring of any recipient.
      const needle = /^to:"(.*)"$/
        .exec(url.searchParams.get("query") ?? "")![1]!
        .toLowerCase();
      const all = this.messages.filter((message) =>
        [...message.To!, ...message.Cc!, ...message.Bcc!].some((address) =>
          address.Address.toLowerCase().includes(needle),
        ),
      );
      const start = Number(url.searchParams.get("start"));
      const limit = Number(url.searchParams.get("limit"));
      return reply(200, {
        messages: all.slice(start, start + limit),
        messages_count: all.length,
      });
    }
    if (method === "GET" && url.pathname.startsWith("/api/v1/message/")) {
      const id = decodeURIComponent(
        url.pathname.slice("/api/v1/message/".length),
      );
      const found = this.messages.find((message) => message.ID === id);
      return found ? reply(200, found) : reply(404);
    }
    if (method === "DELETE" && url.pathname === "/api/v1/messages") {
      const ids = (body as { IDs?: string[] } | undefined)?.IDs ?? [];
      if (ids.length === 0) {
        // What the real Mailpit would do. The client must never get here.
        this.messages.length = 0;
        return reply(200);
      }
      for (const id of ids) {
        const index = this.messages.findIndex((message) => message.ID === id);
        if (index >= 0) {
          this.messages.splice(index, 1);
        }
      }
      return reply(200);
    }
    return reply(404);
  };
}

describe("MailpitClient", () => {
  let mailpit: FakeMailpit;
  let clock: number;
  let client: MailpitClient;

  beforeEach(() => {
    mailpit = new FakeMailpit();
    clock = 0;
    client = new MailpitClient(
      {},
      {
        fetch: mailpit.fetch,
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
      },
    );
  });

  it("talks to the local Mailpit only", () => {
    expect(client.baseUrl).toBe("http://127.0.0.1:8025");
    for (const url of [
      "http://mail.provider.example:8025",
      "https://127.0.0.1:8025",
      "http://user:pass@127.0.0.1:8025",
    ]) {
      expect(() => new MailpitClient({ E2E_MAILPIT_URL: url })).toThrow(
        E2eMailBoundaryError,
      );
    }
  });

  it("refuses a Mailpit that could relay a captured message to a real server", async () => {
    await expect(client.preflight()).resolves.toEqual({ version: "v1.31.4" });
    mailpit.relayEnabled = true;
    await expect(client.preflight()).rejects.toThrow(/message relay enabled/);
  });

  it("waits for the one message to the exact recipient with the exact subject", async () => {
    const recipient = "authmail-123@example.test";
    // Everything Mailpit's own search would also return, plus noise.
    mailpit.add(
      ["xauthmail-123@example.test"],
      "Finish creating your FactorSage account",
    );
    mailpit.add(
      ["Authmail-123@Example.test"],
      "Finish creating your FactorSage account",
    );
    mailpit.add(
      [recipient, "someone@example.test"],
      "Finish creating your FactorSage account",
    );
    mailpit.add([recipient], "You already have a FactorSage account");
    mailpit.add(
      ["authmail-1234@example.test"],
      "Finish creating your FactorSage account",
    );

    // The intended message arrives only after a few polls.
    let polls = 0;
    const fetch = mailpit.fetch;
    let wanted: string | undefined;
    const slow = new MailpitClient(
      {},
      {
        fetch: (input, init) => {
          if (input.includes("/api/v1/search") && (polls += 1) === 4) {
            wanted = mailpit.add(
              [recipient],
              "Finish creating your FactorSage account",
              {
                Text: "body",
              },
            );
          }
          return fetch(input, init);
        },
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
      },
    );

    const message = await slow.waitForMessage({
      to: recipient,
      subject: "Finish creating your FactorSage account",
    });
    expect(message.ID).toBe(wanted);
    expect(message.Text).toBe("body");
    expect(polls).toBe(4);
    expect(clock).toBe(3 * 250);
  });

  it("gives up at its deadline, naming the recipient and never a link", async () => {
    await expect(
      client.waitForMessage({
        to: "authmail-1@example.test",
        subject: "Reset your FactorSage password",
        timeoutMs: 2_000,
        pollMs: 500,
      }),
    ).rejects.toThrow(
      /No "Reset your FactorSage password" message reached Mailpit for authmail-1@example\.test within 2000 ms/,
    );
    expect(clock).toBe(2_000);
  });

  it("fails rather than guess when two messages match", async () => {
    mailpit.add(["authmail-1@example.test"], "Reset your FactorSage password");
    mailpit.add(["authmail-1@example.test"], "Reset your FactorSage password");
    await expect(
      client.waitForMessage({
        to: "authmail-1@example.test",
        subject: "Reset your FactorSage password",
      }),
    ).rejects.toThrow(/found 2/);
  });

  it("never sends a delete without IDs, which Mailpit reads as delete everything", async () => {
    mailpit.add(["person@example.com"], "unrelated");
    await expect(client.deleteMessages([])).rejects.toThrow(/whole mailbox/);
    await expect(client.deleteMessages([""])).rejects.toThrow(/whole mailbox/);
    expect(
      mailpit.requests.filter((request) => request.method === "DELETE"),
    ).toEqual([]);
    expect(mailpit.messages).toHaveLength(1);

    // Nothing addressed to the recipient: no request at all, rather than an empty one.
    await expect(
      client.deleteMessagesTo("authmail-1@example.test"),
    ).resolves.toBe(0);
    await expect(client.sweepDisposableKind("authmail")).resolves.toBe(0);
    expect(
      mailpit.requests.filter((request) => request.method === "DELETE"),
    ).toEqual([]);
  });

  it("deletes a recipient's own messages and nothing that merely resembles them", async () => {
    const recipient = "authmail-123@example.test";
    const own = [mailpit.add([recipient], "a"), mailpit.add([recipient], "b")];
    const kept = [
      mailpit.add(["xauthmail-123@example.test"], "a"),
      mailpit.add(["Authmail-123@Example.test"], "a"),
      mailpit.add([recipient, "person@example.com"], "a"),
      mailpit.add(["person@example.com"], "a"),
    ];

    await expect(client.deleteMessagesTo(recipient)).resolves.toBe(2);
    const deletes = mailpit.requests.filter(
      (request) => request.method === "DELETE",
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.path).toBe("/api/v1/messages");
    expect((deletes[0]!.body as { IDs: string[] }).IDs.sort()).toEqual(
      own.sort(),
    );
    expect(mailpit.messages.map((message) => message.ID).sort()).toEqual(
      kept.sort(),
    );
  });

  it("sweeps only messages every recipient of which is an authmail address, across pages", async () => {
    const owned: string[] = [];
    for (let index = 0; index < 450; index += 1) {
      owned.push(
        mailpit.add(
          [`authmail-${index}@example.test`],
          "Finish creating your FactorSage account",
        ),
      );
    }
    const kept = [
      mailpit.add(
        ["escalation-1@example.test"],
        "Finish creating your FactorSage account",
      ),
      mailpit.add(["authmail-1@example.test", "person@example.com"], "x"),
      mailpit.add(["xauthmail-1@example.test"], "x"),
      mailpit.add(["person@example.com"], "x"),
    ];

    await expect(client.sweepDisposableKind("authmail")).resolves.toBe(450);
    expect(mailpit.messages.map((message) => message.ID).sort()).toEqual(
      kept.sort(),
    );
    await expect(client.messagesOwnedBy("authmail")).resolves.toEqual([]);
  });
});
