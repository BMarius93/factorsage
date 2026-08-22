import { getWorkerConfig, loadRootEnv } from "@intrinsic/config";
import pino from "pino";

loadRootEnv();
const config = getWorkerConfig();

const logger = pino({
  name: "intrinsic-worker",
  level: config.logLevel,
});

let stopping = false;

function shutdown(signal: string) {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info({ signal }, "worker stopping");
  process.exitCode = 0;
  clearInterval(keepAlive);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

logger.info("worker foundation started; no job processors are registered yet");

const keepAlive = setInterval(() => {
  logger.debug("worker foundation heartbeat");
}, 60_000);
