import { Module } from "@nestjs/common";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { ConfigurationModule } from "./config/configuration.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health.controller";
import { ListsModule } from "./lists/lists.module";
import { StocksModule } from "./stocks/stocks.module";

@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
    AuthModule,
    AdminModule,
    ListsModule,
    StocksModule,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
