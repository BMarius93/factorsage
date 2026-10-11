import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  ACTOR_GROUP_MAX_MEMBERS,
  ACTOR_RESOLVE_MAX_IDS,
  normalizeStrategyDefinition,
  type ActorGroupDetailResponse,
  type ActorGroupSummaryResponse,
  type AlternativeDataActorResponse,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { StrategiesModule } from "../strategies/strategies.module";
import { definitionHashOf } from "../strategies/strategy-versions";
import { ActorGroupsService } from "./actor-groups.service";
import { AlternativeDataModule } from "./alternative-data.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * HTTP -> Nest -> ActorGroupsService -> real PostgreSQL.
 *
 * It exercises the rules that cannot be proven in a unit test: ownership scoping, the catalog guard on
 * membership, the structural member bound under a concurrent add, and the refusal to delete a group a
 * strategy still references.
 *
 * Congress groups left the product on 2026-10-11 and no surface manages them any more. These routes
 * stay because strategies saved before then still name groups, and the suite stays with them: a
 * legacy route that silently broke would take those strategies' names and their one-step conversion
 * with it. `StrategiesModule` is compiled alongside so the write boundary's refusal of a new group
 * reference is exercised through the real strategy path.
 */
describe("actor groups", () => {
  const suffix = randomUUID();
  const password = "Local-test-password-42";
  const ownerEmail = `group-owner-${suffix}@example.test`;
  const otherEmail = `group-other-${suffix}@example.test`;

  let app: INestApplication;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;
  let guest: ReturnType<typeof request.agent>;
  /** Three members of Congress, created by this suite. */
  let congressIds: string[] = [];

  const externalIds = [
    `CONG-A-${suffix}`,
    `CONG-B-${suffix}`,
    `CONG-C-${suffix}`,
  ];

  async function createGroup(
    agent: ReturnType<typeof request.agent>,
    body: object,
  ): Promise<ActorGroupDetailResponse> {
    const response = await agent.post("/actor-groups").send(body).expect(201);
    return response.body as ActorGroupDetailResponse;
  }

  function congressStrategy(groupId: string): StrategyDefinition {
    return {
      schemaVersion: 2,
      buyLevels: [
        {
          id: randomUUID(),
          percentage: 100,
          signal: {
            conditions: [
              {
                id: randomUUID(),
                metric: {
                  kind: "CONGRESS_ACTIVITY",
                  measure: "PURCHASES",
                  lookback: 30,
                  scope: { kind: "GROUP", groupId },
                  chamber: "ANY",
                },
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 1 },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    };
  }

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigurationModule,
        DatabaseModule,
        AuthModule,
        AlternativeDataModule,
        StrategiesModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = moduleRef.get(PrismaService);
    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [
        { email: ownerEmail, passwordHash, emailVerifiedAt, plan: "PRO" },
        { email: otherEmail, passwordHash, emailVerifiedAt, plan: "PRO" },
      ],
    });

    await prisma.alternativeDataActor.createMany({
      data: [
        {
          externalId: externalIds[0] as string,
          displayName: `Rep Example ${suffix}`,
          chamber: "HOUSE",
          state: "TX",
          district: "TX17",
        },
        {
          externalId: externalIds[1] as string,
          displayName: `Sen Example ${suffix}`,
          chamber: "SENATE",
          state: "AL",
        },
        {
          externalId: externalIds[2] as string,
          displayName: `Rep Second ${suffix}`,
          chamber: "HOUSE",
          state: "CA",
          district: "CA12",
        },
      ],
    });
    congressIds = (
      await prisma.alternativeDataActor.findMany({
        where: { externalId: { in: externalIds } },
        orderBy: { externalId: "asc" },
        select: { id: true },
      })
    ).map((row) => row.id);

    owner = request.agent(app.getHttpServer());
    other = request.agent(app.getHttpServer());
    guest = request.agent(app.getHttpServer());
    await owner
      .post("/auth/login")
      .send({ email: ownerEmail, password })
      .expect(200);
    await other
      .post("/auth/login")
      .send({ email: otherEmail, password })
      .expect(200);
  });

  afterAll(async () => {
    if (prisma) {
      // Groups and memberships cascade from the users; the actors do not, and are removed explicitly
      // because `ActorGroupMember.actorId` is `Restrict` on purpose.
      await prisma.user.deleteMany({
        where: { email: { in: [ownerEmail, otherEmail] } },
      });
      await prisma.alternativeDataActor.deleteMany({
        where: { externalId: { in: externalIds } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // Actor catalog
  // -------------------------------------------------------------------------

  it("searches the actor catalog without a session", async () => {
    const response = await guest
      .get("/alternative-data/actors")
      .query({ q: `Rep Example ${suffix}` })
      .expect(200);
    const actors = response.body as AlternativeDataActorResponse[];
    expect(actors.map((actor) => actor.externalId)).toEqual([externalIds[0]]);
    expect(actors[0]?.chamber).toBe("HOUSE");
    expect(actors[0]?.district).toBe("TX17");
  });

  it("matches on the external identifier as well as the name", async () => {
    const response = await guest
      .get("/alternative-data/actors")
      .query({ q: externalIds[1] as string })
      .expect(200);
    const actors = response.body as AlternativeDataActorResponse[];
    expect(actors[0]?.chamber).toBe("SENATE");
    expect(actors[0]?.state).toBe("AL");
  });

  it("still finds a member whose stored name differs from the one typed, by the words they share", async () => {
    // The catalog holds whichever spelling the provider last sent: "Rafael E Cruz" for the senator
    // everybody searches for as "Ted Cruz". Matched whole, that term finds nobody.
    const surname = `Cruzfixture${suffix.slice(0, 8)}`;
    const others = [
      {
        externalId: `CONG-D-${suffix}`,
        displayName: `Rafael E ${surname}`,
        chamber: "SENATE" as const,
        state: "TX",
      },
      {
        externalId: `CONG-E-${suffix}`,
        displayName: `Ted Elsewhere${suffix.slice(0, 8)}`,
        chamber: "HOUSE" as const,
        state: "CA",
      },
    ];
    await prisma.alternativeDataActor.createMany({ data: others });
    try {
      const response = await guest
        .get("/alternative-data/actors")
        .query({ q: `Ted ${surname}`, limit: 50 })
        .expect(200);
      const names = (response.body as AlternativeDataActorResponse[]).map(
        (actor) => actor.displayName,
      );
      expect(names).toContain(`Rafael E ${surname}`);

      // The member sharing the surname ranks ahead of nobody who shares more of the term, and the
      // one sharing only the first name is offered too: the reader recognizes the right row by its
      // chamber and state.
      expect(names).toContain(`Ted Elsewhere${suffix.slice(0, 8)}`);

      // It is a fallback only. A term that matches somebody whole returns exactly that, never
      // diluted with names that merely share a word with it.
      const exact = await guest
        .get("/alternative-data/actors")
        .query({ q: `Rafael E ${surname}`, limit: 50 })
        .expect(200);
      expect(
        (exact.body as AlternativeDataActorResponse[]).map(
          (actor) => actor.displayName,
        ),
      ).toEqual([`Rafael E ${surname}`]);

      // And a one-word term is exactly the search it always was.
      const single = await guest
        .get("/alternative-data/actors")
        .query({ q: surname })
        .expect(200);
      expect(
        (single.body as AlternativeDataActorResponse[]).map(
          (actor) => actor.displayName,
        ),
      ).toEqual([`Rafael E ${surname}`]);
    } finally {
      await prisma.alternativeDataActor.deleteMany({
        where: { externalId: { in: others.map((actor) => actor.externalId) } },
      });
    }
  });

  it("resolves actors by id so a saved scope can be labelled", async () => {
    const response = await guest
      .get("/alternative-data/actors/resolve")
      .query({ ids: `${congressIds[0]},${randomUUID()}` })
      .expect(200);
    const actors = response.body as AlternativeDataActorResponse[];
    // An unknown id is absent rather than an error: ids are opaque and a stale one must not break a page.
    expect(actors.map((actor) => actor.id)).toEqual([congressIds[0]]);
  });

  it("resolves a whole batch, counts a repeated id once, and refuses more than one batch", async () => {
    const batch = await guest
      .get("/alternative-data/actors/resolve")
      .query({ ids: [...congressIds, ...congressIds].join(",") })
      .expect(200);
    expect(
      (batch.body as AlternativeDataActorResponse[]).map((actor) => actor.id).sort(),
    ).toEqual([...congressIds].sort());

    const atTheBound = Array.from({ length: ACTOR_RESOLVE_MAX_IDS }, () =>
      randomUUID(),
    );
    await guest
      .get("/alternative-data/actors/resolve")
      .query({ ids: atTheBound.join(",") })
      .expect(200);
    const refusal = await guest
      .get("/alternative-data/actors/resolve")
      .query({ ids: [...atTheBound, randomUUID()].join(",") })
      .expect(400);
    expect(String(refusal.body.message)).toContain(
      `at most ${ACTOR_RESOLVE_MAX_IDS} actors`,
    );
  });

  // -------------------------------------------------------------------------
  // Group CRUD
  // -------------------------------------------------------------------------

  it("creates, reads, renames and deletes a group", async () => {
    const members = [congressIds[0] as string, congressIds[1] as string];
    const created = await createGroup(owner, {
      name: "Congress Watchlist",
      description: "Worth watching",
      actorIds: members,
    });
    expect(created.memberCount).toBe(2);
    expect(created.canEdit).toBe(true);
    expect(created.ownership).toBe("USER");
    // Members render in the order they were added.
    expect(created.members.map((member) => member.id)).toEqual(members);

    const read = await owner.get(`/actor-groups/${created.id}`).expect(200);
    expect((read.body as ActorGroupDetailResponse).name).toBe(
      "Congress Watchlist",
    );

    const renamed = await owner
      .patch(`/actor-groups/${created.id}`)
      .send({ name: "Smart money", description: null })
      .expect(200);
    expect((renamed.body as ActorGroupSummaryResponse).name).toBe("Smart money");
    expect(
      (renamed.body as ActorGroupSummaryResponse).description,
    ).toBeUndefined();

    await owner.delete(`/actor-groups/${created.id}`).expect(204);
    await owner.get(`/actor-groups/${created.id}`).expect(404);
  });

  it("lists the caller's own groups", async () => {
    const first = await createGroup(owner, { name: "Watchlist A" });
    const second = await createGroup(owner, { name: "Watchlist B" });

    const all = await owner.get("/actor-groups").expect(200);
    const ids = (all.body as ActorGroupSummaryResponse[]).map(
      (group) => group.id,
    );
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);

    await owner.delete(`/actor-groups/${first.id}`).expect(204);
    await owner.delete(`/actor-groups/${second.id}`).expect(204);
  });

  it("hides another customer's group behind the same 404 a missing one gets", async () => {
    const group = await createGroup(owner, { name: "Private" });
    await other.get(`/actor-groups/${group.id}`).expect(404);
    await other.patch(`/actor-groups/${group.id}`).send({ name: "x" }).expect(404);
    await other.delete(`/actor-groups/${group.id}`).expect(404);
    await other
      .post(`/actor-groups/${group.id}/members`)
      .send({ actorIds: [congressIds[0] as string] })
      .expect(404);
    // Still intact.
    expect((await owner.get(`/actor-groups/${group.id}`).expect(200)).body).toMatchObject({
      name: "Private",
    });
    await owner.delete(`/actor-groups/${group.id}`).expect(204);
  });

  it("requires a session to write and allows a guest to read built-ins only", async () => {
    await guest.post("/actor-groups").send({ name: "Nope" }).expect(401);
    const listing = await guest.get("/actor-groups").expect(200);
    // No built-ins are seeded in V1, so a Guest legitimately sees an empty collection.
    expect(Array.isArray(listing.body)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  it("adds members idempotently and removes them", async () => {
    const pair = [congressIds[0] as string, congressIds[1] as string];
    const group = await createGroup(owner, {
      name: "Growing",
      actorIds: [pair[0] as string],
    });

    const added = await owner
      .post(`/actor-groups/${group.id}/members`)
      .send({ actorIds: pair })
      .expect(200);
    expect((added.body as ActorGroupDetailResponse).memberCount).toBe(2);

    // Adding the same actors again changes nothing.
    const again = await owner
      .post(`/actor-groups/${group.id}/members`)
      .send({ actorIds: pair })
      .expect(200);
    expect((again.body as ActorGroupDetailResponse).memberCount).toBe(2);

    await owner
      .delete(`/actor-groups/${group.id}/members/${pair[1]}`)
      .expect(204);
    // Removing a non-member is a no-op, so a retry is harmless.
    await owner
      .delete(`/actor-groups/${group.id}/members/${pair[1]}`)
      .expect(204);
    expect(
      (
        (await owner.get(`/actor-groups/${group.id}`).expect(200))
          .body as ActorGroupDetailResponse
      ).memberCount,
    ).toBe(1);

    await owner.delete(`/actor-groups/${group.id}`).expect(204);
  });

  it("refuses an actor that is not in the catalog, on create and on add", async () => {
    await owner
      .post("/actor-groups")
      .send({ name: "Ghosts", actorIds: [randomUUID()] })
      .expect(400);

    const group = await createGroup(owner, { name: "Congress watchlist" });
    await owner
      .post(`/actor-groups/${group.id}/members`)
      .send({ actorIds: [randomUUID()] })
      .expect(400);
    await owner.delete(`/actor-groups/${group.id}`).expect(204);
  });

  it("enforces the member bound inside the writing transaction", async () => {
    // The bound is checked against the membership the transaction finds, not against a count read
    // before it, so two concurrent adds cannot both pass.
    const service = app.get(ActorGroupsService);
    const ownerRow = await prisma.user.findUniqueOrThrow({
      where: { email: ownerEmail },
    });
    const group = await prisma.actorGroup.create({
      data: { userId: ownerRow.id, name: `Full group ${suffix}` },
    });
    // Fill it to exactly the bound with placeholder actors, then try to add one more.
    const filler = Array.from({ length: ACTOR_GROUP_MAX_MEMBERS }, (_, index) => ({
      externalId: `FILL-${index}-${suffix}`,
      displayName: `Filler ${index}`,
      chamber: "HOUSE" as const,
    }));
    await prisma.alternativeDataActor.createMany({ data: filler });
    const fillerIds = (
      await prisma.alternativeDataActor.findMany({
        where: { externalId: { in: filler.map((actor) => actor.externalId) } },
        select: { id: true },
      })
    ).map((row) => row.id);
    await prisma.actorGroupMember.createMany({
      data: fillerIds.map((actorId) => ({ groupId: group.id, actorId })),
    });

    await expect(
      service.addMembers(
        { id: ownerRow.id, email: ownerEmail, role: "USER", plan: "PRO" },
        group.id,
        [congressIds[0] as string],
      ),
    ).rejects.toThrow(/at most/);

    await prisma.actorGroup.delete({ where: { id: group.id } });
    await prisma.alternativeDataActor.deleteMany({
      where: { externalId: { in: filler.map((actor) => actor.externalId) } },
    });
  });

  // -------------------------------------------------------------------------
  // Strategy references
  // -------------------------------------------------------------------------

  /**
   * A strategy as it was saved before groups left the product, written straight to the tables.
   *
   * The API refuses to write a group scope now, so the only way one exists is that it already did.
   */
  async function createLegacyGroupStrategy(
    email: string,
    name: string,
    groupId: string,
  ): Promise<string> {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const definition = normalizeStrategyDefinition(congressStrategy(groupId));
    const strategy = await prisma.strategy.create({
      data: {
        userId: user.id,
        name,
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as unknown as Prisma.InputJsonValue,
            definitionHash: definitionHashOf(definition),
          },
        },
      },
    });
    return strategy.id;
  }

  it("refuses to delete a group a strategy saved earlier still references", async () => {
    const group = await createGroup(owner, {
      name: "Referenced",
      actorIds: [congressIds[0] as string],
    });
    const strategyId = await createLegacyGroupStrategy(
      ownerEmail,
      `Congressional strategy ${suffix}`,
      group.id,
    );

    const refusal = await owner.delete(`/actor-groups/${group.id}`).expect(409);
    expect(String(refusal.body.message)).toContain(
      `Congressional strategy ${suffix}`,
    );

    // Once the strategy selects the members itself the group deletes normally.
    await owner
      .put(`/strategies/${strategyId}/definition`)
      .send({
        definition: {
          schemaVersion: 2,
          buyLevels: [
            {
              id: randomUUID(),
              percentage: 100,
              signal: {
                conditions: [
                  {
                    id: randomUUID(),
                    metric: {
                      kind: "CONGRESS_ACTIVITY",
                      measure: "PURCHASES",
                      lookback: 30,
                      scope: {
                        kind: "ACTORS",
                        actorIds: [congressIds[0] as string],
                      },
                      chamber: "ANY",
                    },
                    operator: "IS_ABOVE",
                    value: { kind: "NUMBER", value: 1 },
                  },
                ],
              },
            },
          ],
          sellLevels: [],
        },
      })
      .expect(200);
    await owner.delete(`/actor-groups/${group.id}`).expect(204);
    await owner.delete(`/strategies/${strategyId}`).expect(204);
  });

  it("refuses to write a strategy that references a group, the caller's own included", async () => {
    const mine = await createGroup(owner, {
      name: "Mine",
      actorIds: [congressIds[0] as string],
    });
    for (const agent of [owner, other]) {
      const refusal = await agent
        .post("/strategies")
        .send({
          name: `Group strategy ${suffix}`,
          definition: congressStrategy(mine.id),
        })
        .expect(400);
      expect(refusal.body.code).toBe("STRATEGY_INVALID");
      expect(
        (refusal.body.issues as { code: string; message: string }[]).map(
          (issue) => [issue.code, issue.message],
        ),
      ).toEqual([
        [
          "SCOPE_INVALID",
          "Congress purchases uses a Congress group, and groups are no longer supported. Open its configuration and choose the members it counts.",
        ],
      ]);
    }
    await owner.delete(`/actor-groups/${mine.id}`).expect(204);
  });
});
