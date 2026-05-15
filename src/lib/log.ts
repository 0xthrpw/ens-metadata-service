// Structured, dependency-free logging for Cloudflare Workers.
//
// COST MODEL: wrangler.toml sets `[observability] head_sampling_rate = 1`, so
// every request's console output is ingested by Workers Logs and is billable.
// To keep this cheap:
//   - the default level is `info`, not `debug`
//   - there is exactly one `info` line per request (the request_complete line)
//   - all cache-seam / gateway-win lines are `debug` (zero cost at the default
//     level — gated *before* the JSON is built, not just before console.*)
//   - 4xx HttpErrors are not logged at all (highest-volume "errors")
// Each call emits ONE single-line JSON object via console[level], which the
// Workers Logs UI parses into structured, queryable fields.

import { HttpError } from "./errors";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const CONSOLE: Record<LogLevel, (msg: string) => void> = {
  debug: (m) => console.debug(m),
  info: (m) => console.info(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

const STACK_CAP = 1000;
const MAX_LOG_BYTES = 16 * 1024;
const MAX_DEPTH = 4;

export function parseLevel(raw: string | undefined): LogLevel {
  switch ((raw ?? "").toLowerCase()) {
    case "debug":
      return "debug";
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "info":
      return "info";
    default:
      return "info";
  }
}

function normalizeError(err: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    // Subclasses (HttpError) don't set `name`, so prefer the constructor name.
    name: err.constructor?.name || err.name,
    message: err.message,
  };
  if (err instanceof HttpError) {
    out.status = err.status;
    if (err.code) out.code = err.code;
  }
  if (typeof err.stack === "string") {
    out.stack =
      err.stack.length > STACK_CAP ? err.stack.slice(0, STACK_CAP) : err.stack;
  }
  // Recurse into `cause` exactly one level (the top-level error is depth 1).
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && depth <= 1) {
    out.cause = normalize(cause, seen, depth + 1);
  }
  return out;
}

function normalize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "bigint") return String(value);
  if (t === "function" || t === "symbol") return undefined;
  if (t !== "object") return value;
  if (value instanceof Error) return normalizeError(value, seen, depth);
  const obj = value as object;
  if (seen.has(obj)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(obj);
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v, seen, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = normalize(v, seen, depth + 1);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

function emit(
  level: LogLevel,
  event: string,
  base: Record<string, unknown>,
  fields: Record<string, unknown> | undefined,
): void {
  try {
    const seen = new WeakSet<object>();
    const record: Record<string, unknown> = {
      level,
      event,
      time: new Date().toISOString(),
    };
    for (const [k, v] of Object.entries(base)) {
      const n = normalize(v, seen, 1);
      if (n !== undefined) record[k] = n;
    }
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        const n = normalize(v, seen, 1);
        if (n !== undefined) record[k] = n;
      }
    }
    let line = JSON.stringify(record);
    if (line.length > MAX_LOG_BYTES) {
      line = JSON.stringify({
        level,
        event,
        time: record.time,
        ...base,
        truncated: true,
        head: line.slice(0, MAX_LOG_BYTES),
      });
    }
    CONSOLE[level](line);
  } catch {
    try {
      CONSOLE[level](`{"level":"${level}","event":"${event}","logErr":1}`);
    } catch {
      /* logging must never throw */
    }
  }
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(extra: Record<string, unknown>): Logger;
}

function makeLogger(
  base: Record<string, unknown>,
  getMin: () => number,
): Logger {
  const make =
    (level: LogLevel) =>
    (event: string, fields?: Record<string, unknown>): void => {
      if (RANK[level] < getMin()) return;
      emit(level, event, base, fields);
    };
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    child(extra) {
      return makeLogger({ ...base, ...extra }, getMin);
    },
  };
}

export function createLogger(
  base: Record<string, unknown> = {},
  minLevel: LogLevel = "info",
): Logger {
  const min = RANK[minLevel];
  return makeLogger(base, () => min);
}

// The default logger's level mirrors the deployment's LOG_LEVEL — a
// deployment-wide [vars] value, identical for every request. It can't be
// read at module-init on Workers, so the request middleware calls
// setDefaultLevel(); idempotent since the env value is constant.
let defaultMinRank = RANK.info;

export function setDefaultLevel(level: LogLevel): void {
  defaultMinRank = RANK[level];
}

// Default logger for code with no request context (waitUntil tasks, the
// service layer). Its level follows setDefaultLevel(), so LOG_LEVEL=debug
// actually enables the cache-seam / gateway diagnostics routed through it.
export const log: Logger = makeLogger({}, () => defaultMinRank);

// Make `c.get("log")` / `c.set("log", …)` typed in every Hono context without
// threading a Variables generic through each route module (which would force
// every sub-app's generic to match the root app's).
declare module "hono" {
  interface ContextVariableMap {
    log: Logger;
  }
}
