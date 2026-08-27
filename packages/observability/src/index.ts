import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "silent";

export type LogContext = {
  requestId?: string;
  correlationId?: string;
  actorUserId?: string;
  runId?: string;
  jobId?: string;
  symbol?: string;
  component?: string;
};

export type LogFields = Record<string, unknown>;

export type LogSink = {
  write(chunk: string): unknown;
};

export type LogMethod = {
  (message: string): void;
  (fields: LogFields, message?: string): void;
};

export type StructuredLogger = {
  child(fields: LogFields): StructuredLogger;
  fatal: LogMethod;
  error: LogMethod;
  warn: LogMethod;
  info: LogMethod;
  debug: LogMethod;
  trace: LogMethod;
};

export type CreateLoggerOptions = {
  service: string;
  level?: LogLevel;
  environment?: string;
  base?: LogFields;
  stdout?: LogSink;
  stderr?: LogSink;
  now?: () => Date;
};

export const OBSERVABILITY_PACKAGE_NAME = "@intrinsic/observability" as const;

const contextStorage = new AsyncLocalStorage<LogContext>();

const LEVEL_PRIORITY: Record<Exclude<LogLevel, "silent">, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const SENSITIVE_KEY_PARTS = [
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "apikey",
  "credential",
];

export function runWithLogContext<T>(
  context: LogContext,
  callback: () => T,
): T {
  const parent = contextStorage.getStore();
  return contextStorage.run(
    {
      ...(parent ?? {}),
      ...definedContext(context),
    },
    callback,
  );
}

export function getLogContext(): Readonly<LogContext> {
  return { ...(contextStorage.getStore() ?? {}) };
}

export function setLogContext(context: Partial<LogContext>): boolean {
  const current = contextStorage.getStore();
  if (!current) {
    return false;
  }

  Object.assign(current, definedContext(context));
  return true;
}

export function createLogger(options: CreateLoggerOptions): StructuredLogger {
  const level = options.level ?? "info";
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? (() => new Date());
  const base = options.base ?? {};

  function child(fields: LogFields): StructuredLogger {
    return createLogger({
      ...options,
      level,
      stdout,
      stderr,
      now,
      base: { ...base, ...fields },
    });
  }

  function method(logLevel: Exclude<LogLevel, "silent">): LogMethod {
    return ((first: string | LogFields, message?: string) => {
      if (!shouldLog(level, logLevel)) {
        return;
      }

      const fields = typeof first === "string" ? {} : first;
      const resolvedMessage = typeof first === "string" ? first : message;
      const context = contextStorage.getStore() ?? {};
      const sanitized = sanitizeValue({
        ...base,
        ...fields,
        ...context,
      });
      const record =
        sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
          ? (sanitized as LogFields)
          : {};

      const output = {
        ...record,
        timestamp: now().toISOString(),
        level: logLevel,
        service: options.service,
        ...(options.environment ? { environment: options.environment } : {}),
        ...(resolvedMessage ? { message: resolvedMessage } : {}),
      };
      const sink = logLevel === "fatal" || logLevel === "error" ? stderr : stdout;
      sink.write(`${JSON.stringify(output)}\n`);
    }) as LogMethod;
  }

  return {
    child,
    fatal: method("fatal"),
    error: method("error"),
    warn: method("warn"),
    info: method("info"),
    debug: method("debug"),
    trace: method("trace"),
  };
}

function shouldLog(
  configured: LogLevel,
  candidate: Exclude<LogLevel, "silent">,
): boolean {
  return configured !== "silent" && LEVEL_PRIORITY[candidate] >= LEVEL_PRIORITY[configured];
}

function definedContext<T extends Partial<LogContext>>(context: T): Partial<LogContext> {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as Partial<LogContext>;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll("-", "").replaceAll("_", "");
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (depth >= 8) {
    return "[MaxDepth]";
  }
  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = isSensitiveKey(key)
      ? "[REDACTED]"
      : sanitizeValue(nested, seen, depth + 1);
  }
  return result;
}
