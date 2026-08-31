import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StocksModule } from "../stocks/stocks.module";
import { AdminController } from "./admin.controller";

@Module({
  imports: [AuthModule, StocksModule],
  controllers: [AdminController],
})
export class AdminModule {}
