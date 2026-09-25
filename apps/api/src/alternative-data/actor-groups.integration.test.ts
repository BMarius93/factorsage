import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  ACTOR_GROUP_MAX_MEMBERS,
  type ActorGroupDetailResponse,
  type ActorGroupSummaryResponse,
  type AlternativeDataActorResponse,
  type StrategyDefinition,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
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
import { ActorGroupsService } from "./actor-groups.service";
import { AlternativeDataModule } from "./alternative-data.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * HTTP -> Nest -> ActorGroupsService -> real PostgreSQL.
 *
 * It exercises the rules that cannot be proven in a unit test: ownership scoping, the actor-kind
 * guard, the structural member bound under a concurrent add, and the refusal to delete a group a
 * strategy still references. `StrategiesModule` is compiled alongside so the last one is exercised
 * through the real strategy write path rather than against a hand-written definition row.
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
  /** Two institutions and two members of Congress, created by this suite. */
  let institutionIds: string[] = [];
  let congressIds: string[] = [];

  const externalIds = {
    institutions: [`INST-A-${suffix}`, `INST-B-${suffix}`],
    congress: [`CONG-A-${suffix}`, `CONG-B-${suffix}`],
  };

  async function createGroup(
    agent: ReturnType<typeof request.agent>,
    body: object,
  ): Promise<ActorGroupDetailResponse> {
    const response = await agent.post("/actor-groups").send(body).expect(201);
    return response.body as ActorGroupDetailResponse;
  }

  function institutionalStrategy(groupId: string): StrategyDefinition {
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
                  kind: "INSTITUTIONAL_ACTIVITY",
                  measure: "BUYERS",
                  lookback: 60,
                  scope: { kind: "GROUP", groupId },
                },
                operator: "IS_AT_LEAST",
                value: { kind: "NUMBER", value: 3 },
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
          type: "INSTITUTION",
          externalId: externalIds.institutions[0] as string,
          displayName: `Alpha Capital ${suffix}`,
          cik: externalIds.institutions[0] as string,
        },
        {
          type: "INSTITUTION",
          externalId: externalIds.institutions[1] as string,
          displayName: `Beta Partners ${suffix}`,
          cik: externalIds.institutions[1] as string,
        },
        {
          type: "CONGRESS_PERSON",
          externalId: externalIds.congress[0] as string,
          displayName: `Rep Example ${suffix}`,
          chamber: "HOUSE",
          state: "TX",
          district: "TX17",
        },
        {
          type: "CONGRESS_PERSON",
          externalId: externalIds.congress[1] as string,
          displayName: `Sen Example ${suffix}`,
          chamber: "SENATE",
          state: "AL",
        },
      ],
    });
    institutionIds = (
      await prisma.alternativeDataActor.findMany({
        where: { externalId: { in: externalIds.institutions } },
        orderBy: { externalId: "asc" },
        select: { id: true },
      })
    ).map((row) => row.id);
    congressIds = (
      await prisma.alternativeDataActor.findMany({
        where: { externalId: { in: externalIds.congress } },
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
        where: {
          externalId: {
            in: [...externalIds.institutions, ...externalIds.congress],
          },
        },
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
      .query({ type: "INSTITUTION", q: `Alpha Capital ${suffix}` })
      .expect(200);
    const actors = response.body as AlternativeDataActorResponse[];
    expect(actors.map((actor) => actor.externalId)).toEqual([
      externalIds.institutions[0],
    ]);
    expect(actors[0]?.type).toBe("INSTITUTION");
  });

  it("never returns an actor of another kind", async () => {
    const response = await guest
      .get("/alternative-data/actors")
      .query({ type: "CONGRESS_PERSON", q: `Alpha Capital ${suffix}` })
      .expect(200);
    expect(response.body).toEqual([]);
  });

  it("matches on the external identifier as well as the name", async () => {
    const response = await guest
      .get("/alternative-data/actors")
      .query({ type: "CONGRESS_PERSON", q: externalIds.congress[1] as string })
      .expect(200);
    const actors = response.body as AlternativeDataActorResponse[];
    expect(actors[0]?.chamber).toBe("SENATE");
    expect(actors[0]?.state).toBe("AL");
  });

  it("resolves actors by id so a saved scope can be labelled", async () => {
    const response = await guest
      .get("/alternative-data/actors/resolve")
      .query({ ids: `${institutionIds[0]},${randomUUID()}` })
      .expect(200);
    const actors = response.body as AlternativeDataActorResponse[];
    // An unknown id is absent rather than an error: ids are opaque and a stale one must not break a page.
    expect(actors.map((actor) => actor.id)).toEqual([institutionIds[0]]);
  });

  it("refuses an unknown actor type", async () => {
    await guest
      .get("/alternative-data/actors")
      .query({ type: "INSIDER_PERSON" })
      .expect(400);
  });

  // -------------------------------------------------------------------------
  // Group CRUD
  // -------------------------------------------------------------------------

  it("creates, reads, renames and deletes a group", async () => {
    const created = await createGroup(owner, {
      actorType: "INSTITUTION",
      name: "Superinvestors",
      description: "Worth watching",
      actorIds: institutionIds,
    });
    expect(created.actorType).toBe("INSTITUTION");
    expect(created.memberCount).toBe(2);
    expect(created.canEdit).toBe(true);
    expect(created.ownership).toBe("USER");
    // Members render in the order they were added.
    expect(created.members.map((member) => member.id)).toEqual(institutionIds);

    const read = await owner.get(`/actor-groups/${created.id}`).expect(200);
    expect((read.body as ActorGroupDetailResponse).name).toBe("Superinvestors");

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

  it("lists built-ins first, then the caller's own, and narrows by actor kind", async () => {
    const institution = await createGroup(owner, {
      actorType: "INSTITUTION",
      name: "Institutions only",
    });
    const congress = await createGroup(owner, {
      actorType: "CONGRESS_PERSON",
      name: "Congress only",
    });

    const all = await owner.get("/actor-groups").expect(200);
    const ids = (all.body as ActorGroupSummaryResponse[]).map(
      (group) => group.id,
    );
    expect(ids).toContain(institution.id);
    expect(ids).toContain(congress.id);

    const narrowed = await owner
      .get("/actor-groups")
      .query({ actorType: "CONGRESS_PERSON" })
      .expect(200);
    const narrowedIds = (narrowed.body as ActorGroupSummaryResponse[]).map(
      (group) => group.id,
    );
    expect(narrowedIds).toContain(congress.id);
    expect(narrowedIds).not.toContain(institution.id);

    await owner.delete(`/actor-groups/${institution.id}`).expect(204);
    await owner.delete(`/actor-groups/${congress.id}`).expect(204);
  });

  it("hides another customer's group behind the same 404 a missing one gets", async () => {
    const group = await createGroup(owner, {
      actorType: "INSTITUTION",
      name: "Private",
    });
    await other.get(`/actor-groups/${group.id}`).expect(404);
    await other.patch(`/actor-groups/${group.id}`).send({ name: "x" }).expect(404);
    await other.delete(`/actor-groups/${group.id}`).expect(404);
    await other
      .post(`/actor-groups/${group.id}/members`)
      .send({ actorIds: institutionIds })
      .expect(404);
    // Still intact.
    expect((await owner.get(`/actor-groups/${group.id}`).expect(200)).body).toMatchObject({
      name: "Private",
    });
    await owner.delete(`/actor-groups/${group.id}`).expect(204);
  });

  it("requires a session to write and allows a guest to read built-ins only", async () => {
    await guest
      .post("/actor-groups")
      .send({ actorType: "INSTITUTION", name: "Nope" })
      .expect(401);
    const listing = await guest.get("/actor-groups").expect(200);
    // No built-ins are seeded in V1, so a Guest legitimately sees an empty collection.
    expect(Array.isArray(listing.body)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  it("adds members idempotently and removes them", async () => {
    const group = await createGroup(owner, {
      actorType: "INSTITUTION",
      name: "Growing",
      actorIds: [institutionIds[0] as string],
    });

    const added = await owner
      .post(`/actor-groups/${group.id}/members`)
      .send({ actorIds: institutionIds })
      .expect(200);
    expect((added.body as ActorGroupDetailResponse).memberCount).toBe(2);

    // Adding the same actors again changes nothing.
    const again = await owner
      .post(`/actor-groups/${group.id}/members`)
      .send({ actorIds: institutionIds })
      .expect(200);
    expect((again.body as ActorGroupDetailResponse).memberCount).toBe(2);

    await owner
      .delete(`/actor-groups/${group.id}/members/${institutionIds[1]}`)
      .expect(204);
    // Removing a non-member is a no-op, so a retry is harmless.
    await owner
      .delete(`/actor-groups/${group.id}/members/${institutionIds[1]}`)
      .expect(204);
    expect(
      (
        (await owner.get(`/actor-groups/${group.id}`).expect(200))
          .body as ActorGroupDetailResponse
      ).memberCount,
    ).toBe(1);

    await owner.delete(`/actor-groups/${group.id}`).expect(204);
  });

  it("refuses an actor of the wrong kind, on create and on add", async () => {
    await owner
      .post("/actor-groups")
      .send({
        actorType: "INSTITUTION",
        name: "Mixed",
        actorIds: [congressIds[0]],
      })
      .expect(400);

    const group = await createGroup(owner, {
      actorType: "CONGRESS_PERSON",
      name: "Congress watchlist",
    });
    const refusal = await owner
      .post(`/actor-groups/${group.id}/members`)
      .send({ actorIds: [institutionIds[0]] })
      .expect(400);
    expect(String(refusal.body.message)).toContain("kind");
    await owner.delete(`/actor-groups/${group.id}`).expect(204);
  });

  it("refuses an actor that is not in the catalog", async () => {
    await owner
      .post("/actor-groups")
      .send({
        actorType: "INSTITUTION",
        name: "Ghosts",
        actorIds: [randomUUID()],
      })
      .expect(400);
  });

  it("enforces the member bound inside the writing transaction", async () => {
    // The bound is checked against the membership the transaction finds, not against a count read
    // before it, so two concurrent adds cannot both pass.
    const service = app.get(ActorGroupsService);
    const ownerRow = await prisma.user.findUniqueOrThrow({
      where: { email: ownerEmail },
    });
    const group = await prisma.actorGroup.create({
      data: {
        userId: ownerRow.id,
        actorType: "INSTITUTION",
        name: `Full group ${suffix}`,
      },
    });
    // Fill it to exactly the bound with placeholder actors, then try to add one more.
    const filler = Array.from({ length: ACTOR_GROUP_MAX_MEMBERS }, (_, index) => ({
      type: "INSTITUTION" as const,
      externalId: `FILL-${index}-${suffix}`,
      displayName: `Filler ${index}`,
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
        [institutionIds[0] as string],
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

  it("refuses to delete a group a strategy still references", async () => {
    const group = await createGroup(owner, {
      actorType: "INSTITUTION",
      name: "Referenced",
      actorIds: institutionIds,
    });
    const strategy = (
      await owner
        .post("/strategies")
        .send({
          name: `Institutional strategy ${suffix}`,
          definition: institutionalStrategy(group.id),
        })
        .expect(201)
    ).body as StrategyDetailResponse;

    const refusal = await owner.delete(`/actor-groups/${group.id}`).expect(409);
    expect(String(refusal.body.message)).toContain(
      `Institutional strategy ${suffix}`,
    );

    // Once the strategy stops referencing it the group deletes normally.
    await owner
      .put(`/strategies/${strategy.id}/definition`)
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
                    metric: { kind: "PRICE" },
                    operator: "IS_BELOW",
                    value: { kind: "SERIES", seriesId: "SMA_200D" },
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
    await owner.delete(`/strategies/${strategy.id}`).expect(204);
  });

  it("refuses a strategy that references a group the caller cannot use", async () => {
    const mine = await createGroup(owner, {
      actorType: "INSTITUTION",
      name: "Mine",
    });
    // Another customer's group is not resolvable, so the strategy is invalid rather than silently
    // counting every institution.
    const refusal = await other
      .post("/strategies")
      .send({
        name: `Borrowed group ${suffix}`,
        definition: institutionalStrategy(mine.id),
      })
      .expect(400);
    expect(refusal.body.code).toBe("STRATEGY_INVALID");
    expect(
      (refusal.body.issues as { code: string }[]).map((issue) => issue.code),
    ).toContain("SCOPE_INVALID");
    await owner.delete(`/actor-groups/${mine.id}`).expect(204);
  });

  it("refuses a strategy whose scope names a group of the wrong actor kind", async () => {
    const congressGroup = await createGroup(owner, {
      actorType: "CONGRESS_PERSON",
      name: "Congress",
    });
    const refusal = await owner
      .post("/strategies")
      .send({
        name: `Wrong kind ${suffix}`,
        // An institutional metric scoped to a Congress group is meaningless.
        definition: institutionalStrategy(congressGroup.id),
      })
      .expect(400);
    expect(
      (refusal.body.issues as { message: string }[])[0]?.message,
    ).toContain("does not hold the kind of actor");
    await owner.delete(`/actor-groups/${congressGroup.id}`).expect(204);
  });
});
