import { Module } from "@nestjs/common";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { BacktestsModule } from "./backtests/backtests.module";
import { BenchmarksModule } from "./benchmarks/benchmarks.module";
import { ConfigurationModule } from "./config/configuration.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health.controller";
import { ListsModule } from "./lists/lists.module";
import { StocksModule } from "./stocks/stocks.module";
import { MonitorsModule } from "./monitors/monitors.module";
import { StrategiesModule } from "./strategies/strategies.module";

@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
    AuthModule,
    AdminModule,
    BenchmarksModule,
    BacktestsModule,
    ListsModule,
    StocksModule,
    MonitorsModule,
    StrategiesModule,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
