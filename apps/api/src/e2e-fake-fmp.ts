import { e2eFakeFmpPort, E2E_FAKE_FMP_API_KEY } from "@intrinsic/testing";
import { createFakeFmpServer } from "./e2e-stack/fake-fmp";
import {
  e2eFixtureBenchmarkProviderSymbols,
  e2eFixtureSecuritySymbols,
} from "./e2e-stack/fixture-boundary";

/**
 * Serves the fixture FMP provider the deterministic E2E stack points at (`pnpm dev:fmp:e2e`).
 *
 * Loopback only. Every request is printed — a fixture answer as one quiet line, a missing fixture
 * as `UNEXPECTED` with the exact endpoint and query — and kept in the journal the Playwright
 * teardown reads. Stop it with Ctrl-C; it holds no state worth keeping between runs.
 */
const port = e2eFakeFmpPort();
const fake = createFakeFmpServer(
  {
    apiKey: E2E_FAKE_FMP_API_KEY,
    securitySymbols: new Set(e2eFixtureSecuritySymbols()),
    benchmarkSymbols: new Set(e2eFixtureBenchmarkProviderSymbols()),
  },
  {
    log: (line) => {
      const stream = line.startsWith("UNEXPECTED")
        ? process.stderr
        : process.stdout;
      stream.write(`[e2e-fake-fmp] ${line}\n`);
    },
  },
);

fake.server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `[e2e-fake-fmp] fixture FMP provider listening on http://127.0.0.1:${port}/stable/\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void fake.close().finally(() => process.exit(0));
  });
}
