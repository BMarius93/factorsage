import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BuiltInAdminService } from "../builtins/builtin-admin.service";
import { DatabaseModule } from "../database/database.module";
import { StocksModule } from "../stocks/stocks.module";
import { AdminController } from "./admin.controller";

@Module({
  imports: [AuthModule, DatabaseModule, StocksModule],
  controllers: [AdminController],
  providers: [BuiltInAdminService],
})
export class AdminModule {}
