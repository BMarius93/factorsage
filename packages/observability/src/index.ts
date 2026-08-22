export type LogContext = {
  requestId?: string;
  runId?: string;
  jobId?: string;
};

export const OBSERVABILITY_PACKAGE_NAME = "@intrinsic/observability" as const;
