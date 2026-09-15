import { Module } from "@nestjs/common";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { BacktestsModule } from "./backtests/backtests.module";
import { BenchmarksModule } from "./benchmarks/benchmarks.module";
import { BillingModule } from "./billing/billing.module";
import { ConfigurationModule } from "./config/configuration.module";
import { DatabaseModule } from "./database/database.module";
import { EntitlementsModule } from "./entitlements/entitlements.module";
import { HealthController } from "./health.controller";
import { ListsModule } from "./lists/lists.module";
import { RateLimitModule } from "./rate-limit/rate-limit.module";
import { RecentSearchesModule } from "./recent-searches/recent-searches.module";
import { StocksModule } from "./stocks/stocks.module";
import { MonitorsModule } from "./monitors/monitors.module";
import { StrategiesModule } from "./strategies/strategies.module";

@Module({
  imports: [
    ConfigurationModule,
    // Installs the global rate-limit interceptor and filter. Listed before the feature modules
    // so the protection every route declares is part of the application, not of any one feature.
    RateLimitModule,
    DatabaseModule,
    AuthModule,
    EntitlementsModule,
    AdminModule,
    BenchmarksModule,
    BillingModule,
    BacktestsModule,
    ListsModule,
    RecentSearchesModule,
    StocksModule,
    MonitorsModule,
    StrategiesModule,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
