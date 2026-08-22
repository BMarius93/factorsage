import "reflect-metadata";
import { getApiConfig, loadRootEnv } from "@intrinsic/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  loadRootEnv();
  const config = getApiConfig();

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
  });

  await app.listen(config.port);
}

void bootstrap();
