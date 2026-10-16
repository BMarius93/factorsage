import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  pinnedRequestKey,
  type PinnedProviderResponse,
  type PinnedVenueCalendar,
} from "./matrix-venue-calendar";

/**
 * The only provider a matrix worker can reach: a loopback server that replays the pinned venue
 * calendar and refuses everything else.
 *
 * The sweep's "zero provider requests" used to be measured from one log line,
 * `stock-data.provider.request`. Two kinds of traffic never write it — the venue holiday schedule
 * (`CachedTradingCalendar`) and the alternative-data loader, which logs its own event — and the
 * worker inherited the developer's real `FMP_API_KEY`, so a sweep could reach FMP while reporting
 * zero. Measuring at the network boundary instead makes the ledger complete by construction: the
 * worker pool points `FMP_BASE_URL` here and is given a placeholder key, so every request any code
 * path makes arrives at this server, and nothing can leave the machine.
 *
 * - A request the pinned calendar holds is answered with the provider's own recorded status and
 *   body, exactly. That is pinned data, not provider traffic: it is what makes week completion
 *   reproducible (`matrix-venue-calendar.ts`).
 * - Anything else is refused with `403`, which `FmpClient` classifies as non-retryable, so a refusal
 *   costs one round trip rather than a retry storm — and is journaled. One refusal is enough for the
 *   gate to fail the sweep (`PROVIDER_EGRESS`): it means some run depended on data the matrix does
 *   not pin, whichever code path asked.
 */

export type ProviderGuardJournal = {
  /** Requests answered from the pinned calendar, by request key. */
  readonly served: Readonly<Record<string, number>>;
  readonly servedTotal: number;
  /** Requests refused, by endpoint path, with a few example keys each. */
  readonly refused: Readonly<
    Record<
      string,
      { readonly count: number; readonly examples: readonly string[] }
    >
  >;
  readonly refusedTotal: number;
};

const EXAMPLES_PER_PATH = 5;

export class MatrixProviderGuard {
  private server: Server | null = null;
  private readonly pinned = new Map<string, PinnedProviderResponse>();
  private readonly served = new Map<string, number>();
  private readonly refused = new Map<
    string,
    { count: number; examples: string[] }
  >();

  constructor(calendar: PinnedVenueCalendar | null) {
    for (const response of calendar?.responses ?? []) {
      this.pinned.set(
        pinnedRequestKey(response.path, response.query),
        response,
      );
    }
  }

  /** Starts listening on an ephemeral loopback port and returns the base URL a client should use. */
  async start(): Promise<string> {
    if (this.server) {
      throw new Error("The matrix provider guard is already running.");
    }
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      // `FmpClient` resolves every endpoint relative to `…/stable/`.
      const path = url.pathname
        .replace(/^\/+stable\/+/, "")
        .replace(/^\/+/, "");
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, name) => {
        query[name] = value;
      });
      const key = pinnedRequestKey(path, query);
      const answer = this.pinned.get(key);
      if (answer) {
        this.served.set(key, (this.served.get(key) ?? 0) + 1);
        response.writeHead(answer.status, {
          "content-type": "application/json",
        });
        response.end(answer.body);
        return;
      }
      const entry = this.refused.get(path) ?? { count: 0, examples: [] };
      entry.count += 1;
      if (
        entry.examples.length < EXAMPLES_PER_PATH &&
        !entry.examples.includes(key)
      ) {
        entry.examples.push(key);
      }
      this.refused.set(path, entry);
      response.writeHead(403, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error:
            "QA matrix provider guard: this request is not in the pinned dataset and was not sent.",
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/stable/`;
  }

  journal(): ProviderGuardJournal {
    const served = Object.fromEntries(this.served);
    const refused = Object.fromEntries(
      [...this.refused].map(([path, entry]) => [
        path,
        { count: entry.count, examples: [...entry.examples] },
      ]),
    );
    return {
      served,
      servedTotal: [...this.served.values()].reduce(
        (sum, count) => sum + count,
        0,
      ),
      refused,
      refusedTotal: [...this.refused.values()].reduce(
        (sum, entry) => sum + entry.count,
        0,
      ),
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
