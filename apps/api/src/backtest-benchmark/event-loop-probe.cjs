// Benchmark-only preload (`node --require`): samples this process's event-loop delay and writes one
// JSON line to stderr every BENCH_EVENT_LOOP_INTERVAL_MS (default 5000). Loaded into the worker
// processes the scale benchmark starts; never part of a product process.
const { monitorEventLoopDelay } = require("node:perf_hooks");

const interval = Number(process.env.BENCH_EVENT_LOOP_INTERVAL_MS || 5000);
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();

const timer = setInterval(() => {
  const ms = (value) => Math.round((value / 1e6) * 10) / 10;
  process.stderr.write(
    JSON.stringify({
      event: "bench.event-loop",
      pid: process.pid,
      p50Ms: ms(histogram.percentile(50)),
      p99Ms: ms(histogram.percentile(99)),
      maxMs: ms(histogram.max),
      meanMs: ms(histogram.mean),
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      at: new Date().toISOString(),
    }) + "\n",
  );
  histogram.reset();
}, interval);
timer.unref();
