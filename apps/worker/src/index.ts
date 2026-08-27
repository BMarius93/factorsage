import { getWorkerConfig, loadRootEnv } from "@intrinsic/config";
import { createLogger } from "@intrinsic/observability";

loadRootEnv();
const config = getWorkerConfig();

const logger = createLogger({
  service: "worker",
  level: config.logLevel,
  environment: config.environment,
});

let stopping = false;

function shutdown(signal: string) {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info({ event: "worker.stopping", signal });
  process.exitCode = 0;
  clearInterval(keepAlive);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

logger.info(
  { event: "worker.started" },
  "worker foundation started; no job processors are registered yet",
);

const keepAlive = setInterval(() => {
  logger.debug({ event: "worker.heartbeat" });
}, 60_000);
