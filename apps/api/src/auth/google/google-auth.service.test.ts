import { OAuthProvider } from "@intrinsic/database";
import { createLogger } from "@intrinsic/observability";
import { describe, expect, it } from "vitest";
import type { UsersService } from "../users.service";
import { GoogleAuthService } from "./google-auth.service";
import {
  GoogleAuthError,
  type GoogleAuthorizationRequest,
  type GoogleCodeExchange,
  type GoogleIdentity,
  type GoogleIdentityProvider,
} from "./google-identity";

const SILENT_LOGGER = createLogger({
  service: "api",
  level: "silent",
  base: { component: "auth" },
});

const EXCHANGE: GoogleCodeExchange = {
  code: "code",
  codeVerifier: "verifier",
  nonce: "nonce",
};

function identity(overrides: Partial<GoogleIdentity> = {}): GoogleIdentity {
  return {
    providerAccountId: "google-sub",
    email: "person@gmail.com",
    emailVerified: true,
    hostedDomain: null,
    ...overrides,
  };
}

class StubProvider implements GoogleIdentityProvider {
  constructor(private readonly result: GoogleIdentity) {}
  buildAuthorizationUrl(_request: GoogleAuthorizationRequest): string {
    return "https://accounts.google.test/authorize";
  }
  exchangeCode(): Promise<GoogleIdentity> {
    return Promise.resolve(this.result);
  }
}

/** Prisma's shape for "somebody else already wrote this row". */
function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

type UserRow = {
  id: string;
  email: string;
  role: "USER";
  plan: "FREE";
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
};

function userRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "user-1",
    email: "person@gmail.com",
    role: "USER",
    plan: "FREE",
    passwordHash: null,
    emailVerifiedAt: new Date(),
    ...overrides,
  };
}

/**
 * The identity repository, scripted per call.
 *
 * Only the four reads/writes Google resolution performs are implemented, which is what makes the
 * write-race deterministic here: a real concurrent run cannot be asked to collide on demand.
 */
function stubUsers(script: {
  byOAuthAccount?: (UserRow | null)[];
  byEmail?: (UserRow | null)[];
  onCreate?: () => UserRow;
  onLink?: () => UserRow;
}) {
  const calls = { create: 0, link: 0, byOAuthAccount: 0, byEmail: 0 };
  const next = <T,>(queue: T[] | undefined, fallback: T): T =>
    queue && queue.length > 0 ? (queue.shift() as T) : fallback;

  const users = {
    findByOAuthAccount: () => {
      calls.byOAuthAccount += 1;
      return Promise.resolve(next(script.byOAuthAccount, null));
    },
    findByEmail: () => {
      calls.byEmail += 1;
      return Promise.resolve(next(script.byEmail, null));
    },
    createOAuthUser: () => {
      calls.create += 1;
      return Promise.resolve(script.onCreate?.() ?? userRow());
    },
    linkOAuthAccount: () => {
      calls.link += 1;
      return Promise.resolve(script.onLink?.() ?? userRow());
    },
    markEmailVerified: (id: string) =>
      Promise.resolve(userRow({ id, emailVerifiedAt: new Date() })),
    toAuthUser: (user: UserRow) => ({
      id: user.id,
      email: user.email,
      role: user.role,
      plan: user.plan,
    }),
  };

  return { users: users as unknown as UsersService, calls };
}

function service(
  users: UsersService,
  result: GoogleIdentity,
): GoogleAuthService {
  return new GoogleAuthService(users, SILENT_LOGGER, new StubProvider(result));
}

describe("GoogleAuthService identity resolution", () => {
  it("signs in an already-linked identity without touching the email claim", async () => {
    const linked = userRow({ id: "linked", email: "person@example.test" });
    const { users, calls } = stubUsers({ byOAuthAccount: [linked] });

    const user = await service(
      users,
      // External and unverified, and none of it matters: the subject is already linked.
      identity({ email: "person@example.test", emailVerified: false }),
    ).authenticate(EXCHANGE);

    expect(user.id).toBe("linked");
    expect(calls.byEmail).toBe(0);
    expect(calls.create).toBe(0);
    expect(calls.link).toBe(0);
  });

  it("retries once when a concurrent sign-in wins the create race", async () => {
    const winner = userRow({ id: "winner" });
    const { users, calls } = stubUsers({
      // First pass: nothing exists. Second pass: the concurrent request's row.
      byOAuthAccount: [null, winner],
      onCreate: () => {
        throw uniqueViolation();
      },
    });

    const user = await service(users, identity()).authenticate(EXCHANGE);

    expect(user.id).toBe("winner");
    expect(calls.create).toBe(1);
    expect(calls.byOAuthAccount).toBe(2);
  });

  it("retries once when a concurrent sign-in wins the link race", async () => {
    const existing = userRow({ id: "existing", passwordHash: "$argon2id$x" });
    const { users, calls } = stubUsers({
      byOAuthAccount: [null, existing],
      byEmail: [existing],
      onLink: () => {
        throw uniqueViolation();
      },
    });

    const user = await service(users, identity()).authenticate(EXCHANGE);

    expect(user.id).toBe("existing");
    expect(calls.link).toBe(1);
  });

  it("does not retry a failure that is not a uniqueness collision", async () => {
    const { users, calls } = stubUsers({
      onCreate: () => {
        throw new Error("connection reset");
      },
    });

    await expect(
      service(users, identity()).authenticate(EXCHANGE),
    ).rejects.toThrow("connection reset");
    expect(calls.create).toBe(1);
    expect(calls.byOAuthAccount).toBe(1);
  });

  it("refuses a non-authoritative email before writing anything", async () => {
    const existing = userRow({
      id: "victim",
      email: "person@example.test",
      passwordHash: "$argon2id$x",
    });
    const { users, calls } = stubUsers({ byEmail: [existing] });

    const error = await service(
      users,
      identity({ email: "person@example.test" }),
    )
      .authenticate(EXCHANGE)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as GoogleAuthError).code).toBe("oauth_link_not_allowed");
    expect(calls.link).toBe(0);
    expect(calls.create).toBe(0);
  });

  it("reports the provider as unavailable when Google is not configured", async () => {
    const { users } = stubUsers({});
    const disabled = new GoogleAuthService(users, SILENT_LOGGER, null);

    expect(disabled.isEnabled).toBe(false);
    await expect(disabled.authenticate(EXCHANGE)).rejects.toMatchObject({
      code: "oauth_unavailable",
    });
    expect(() =>
      disabled.buildAuthorizationUrl({
        state: "s",
        codeChallenge: "c",
        nonce: "n",
      }),
    ).toThrow(GoogleAuthError);
  });
});

describe("OAuthProvider", () => {
  it("still models Google as the one external provider", () => {
    expect(Object.keys(OAuthProvider)).toEqual(["GOOGLE"]);
  });
});
