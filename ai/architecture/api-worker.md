# API / Worker Boundary

API responsibilities:
- validate requests,
- authorize users,
- create immutable execution snapshots,
- create/queue durable jobs,
- expose execution state/results.

Worker responsibilities:
- claim jobs,
- load required data,
- execute backtests/monitor scans,
- persist progress/results/failures,
- handle graceful shutdown and retry semantics.

Both must call the same domain/valuation logic.
