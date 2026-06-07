import type { Context } from "hono";
import type { Env } from "../env";
import { HttpError } from "./errors";
import { requireBearerToken } from "./auth";

// [value, label] pairs that must be set for an indexer endpoint to function.
// A missing value yields 503 (so a route is never half-exposed on a deploy
// that hasn't configured its secrets).
export type RequiredConfig = ReadonlyArray<
  readonly [value: string | undefined, label: string]
>;

// Order-preserving bounded-concurrency map. With `limit >= items.length` this
// is equivalent to `Promise.all(items.map(fn))`; with a smaller limit it caps
// in-flight work (used by preload to stay within Worker subrequest limits).
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const poolSize = Math.min(Math.max(1, limit), Math.max(1, items.length));
  const workers = Array.from({ length: poolSize }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Shared scaffolding for indexer-only endpoints: bearer auth, required-config
// presence checks, then bounded batched item processing. The route keeps its
// own response aggregation, since invalidate and preload aggregate (and treat
// per-item failure) differently.
export async function runIndexerBatch<I, R>(
  c: Context<{ Bindings: Env }>,
  opts: {
    token: string | undefined;
    tokenLabel: string;
    requiredConfig?: RequiredConfig;
    items: readonly I[];
    concurrency: number;
    handle: (item: I, index: number) => Promise<R>;
  },
): Promise<R[]> {
  requireBearerToken(c, opts.token, opts.tokenLabel);
  for (const [value, label] of opts.requiredConfig ?? []) {
    if (!value) {
      throw new HttpError(503, `${label} not configured`, "not_configured");
    }
  }
  return mapWithConcurrency(opts.items, opts.concurrency, opts.handle);
}
