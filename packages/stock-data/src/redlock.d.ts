declare module "redlock" {
  import type { Cluster, Redis } from "ioredis";

  export type RedlockAbortSignal = AbortSignal & { error?: Error };

  export type RedlockSettings = {
    driftFactor: number;
    retryCount: number;
    retryDelay: number;
    retryJitter: number;
    automaticExtensionThreshold: number;
  };

  export default class Redlock {
    constructor(
      clients: Iterable<Redis | Cluster>,
      settings?: Partial<RedlockSettings>,
    );

    using<T>(
      resources: string[],
      duration: number,
      routine: (signal: RedlockAbortSignal) => Promise<T>,
    ): Promise<T>;
  }
}
