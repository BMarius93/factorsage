import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { AUTH_LOGGER } from "./auth.tokens";

/**
 * Runs account-email work after the HTTP response instead of inside it (AUTH-003).
 *
 * Registration and resend must answer identically whatever the address's state, and a mail
 * transport's round trip — or its failure — is the easiest difference to observe. So the request
 * path only decides and claims; issuing the token and talking to the transport happen here, where
 * neither the elapsed time nor the outcome can reach the caller.
 *
 * Deliberately small. It is not a queue: work lives in this process only, which is acceptable
 * because every task is idempotent from the owner's point of view — a lost task leaves a claim
 * that expires with the cooldown, after which the owner can simply ask again. It never holds a
 * database transaction, and each task is responsible for its own logging and failure handling;
 * the catch below is only the last line of defence.
 *
 * `drain()` waits for everything in flight. Shutdown calls it so a deploy does not drop a message
 * mid-send, and tests call it to observe what a request would have sent.
 */
@Injectable()
export class BackgroundEmailDispatcher implements OnApplicationShutdown {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(@Inject(AUTH_LOGGER) private readonly logger: StructuredLogger) {}

  /** Starts `task` without awaiting it. Never throws, and never rejects anything upstream. */
  run(event: string, task: () => Promise<void>): void {
    const running: Promise<void> = Promise.resolve()
      .then(task)
      .catch((err: unknown) => {
        this.logger.error({ event: `${event}.failed`, err });
      })
      .finally(() => {
        this.inFlight.delete(running);
      });
    this.inFlight.add(running);
  }

  /** Resolves once every task started so far — and any it started in turn — has settled. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  onApplicationShutdown(): Promise<void> {
    return this.drain();
  }
}
