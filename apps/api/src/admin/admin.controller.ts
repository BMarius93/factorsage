import type { AdminHealthResponse } from "@intrinsic/contracts";
import { Controller, Get, UseGuards } from "@nestjs/common";
import { CookieAuthGuard } from "../auth/cookie-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";

@Controller("admin")
@UseGuards(CookieAuthGuard, RolesGuard)
@Roles("ADMIN")
export class AdminController {
  @Get("health")
  health(): AdminHealthResponse {
    return {
      status: "ok",
      role: "ADMIN",
    };
  }
}
