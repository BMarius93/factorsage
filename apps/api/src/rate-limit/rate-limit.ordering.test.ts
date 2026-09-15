import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  UseGuards,
  type INestApplication,
} from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedRequest } from "../auth/authenticated-request";

/**
 * The ordering fact the whole design rests on.
 *
 * `RateLimitInterceptor` keys authenticated traffic by user id, which is only possible if the
 * session has already been resolved when it runs. `CookieAuthGuard` is applied per controller, and
 * Nest runs enhancers global → controller → method — so a **globally registered guard** would run
 * before it and see no session, silently degrading every authenticated route to IP keying. A
 * global **interceptor** runs after every guard.
 *
 * That is the entire reason rate limiting here is an interceptor rather than the guard it looks
 * like it should be, so it is pinned rather than remembered: if a Nest upgrade ever changed this
 * ordering, the design's premise would be gone and this test would say so.
 */

const executionOrder: string[] = [];

@Injectable()
class GlobalGuard implements CanActivate {
  canActivate(): boolean {
    executionOrder.push("global-guard");
    return true;
  }
}

@Injectable()
class ControllerAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    executionOrder.push("controller-guard");
    context.switchToHttp().getRequest<AuthenticatedRequest>().authUser = {
      id: "ordered-user",
      email: "ordered@example.test",
      role: "USER",
      plan: "FREE",
    };
    return true;
  }
}

/**
 * Stands in for `RateLimitInterceptor`, recording only what it could see. Deliberately not the
 * real one: the property under test is the framework's ordering, and asserting it through a
 * limiter would make a Redis failure look like an ordering regression.
 */
@Injectable()
class ObservingInterceptor {
  intercept(
    context: ExecutionContext,
    next: { handle: () => unknown },
  ): unknown {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>()
      .authUser;
    executionOrder.push(`global-interceptor:${user?.id ?? "anonymous"}`);
    return next.handle();
  }
}

@Controller("ordered")
@UseGuards(ControllerAuthGuard)
class OrderedController {
  @Get()
  get(): { ok: true } {
    executionOrder.push("handler");
    return { ok: true };
  }
}

describe("Nest enhancer ordering", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderedController],
      providers: [
        { provide: APP_GUARD, useClass: GlobalGuard },
        { provide: APP_INTERCEPTOR, useClass: ObservingInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("runs a global interceptor after every guard, with the session resolved", async () => {
    executionOrder.length = 0;
    await request(app.getHttpServer()).get("/ordered").expect(200);

    expect(executionOrder).toEqual([
      "global-guard",
      "controller-guard",
      // The session the controller guard resolved is visible here. A global *guard* would have
      // run in the first position and seen `anonymous`.
      "global-interceptor:ordered-user",
      "handler",
    ]);
  });
});
