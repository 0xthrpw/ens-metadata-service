// Node entrypoint. The worker app is served unchanged: Hono's app.fetch
// accepts (request, env, executionCtx), so the Workers platform pieces are
// injected here — a Node-built Env (fs R2, in-memory KV), a fire-and-forget
// ExecutionContext, and global polyfills for HTMLRewriter and caches.default.
// Nothing under src/ outside this directory knows which runtime it's on.
import { serve } from "@hono/node-server";

import app from "../index";
import { log } from "../lib/log";
import { buildEnv } from "./env";
import { installCaches } from "./cacheShim";
import { installHtmlRewriter } from "./htmlRewriter";

installHtmlRewriter();
installCaches();

const env = buildEnv();

// waitUntil on Workers keeps the isolate alive for background cache writes;
// a Node process is always alive, so detaching the promise is equivalent.
// Rejections are swallowed after logging — same fate they meet on Workers.
const executionCtx = {
  waitUntil(promise: Promise<unknown>): void {
    promise.catch((err) => log.warn("wait_until_error", { err }));
  },
  passThroughOnException(): void {},
  props: undefined,
};

const port = Number(process.env.PORT ?? 8080);

const server = serve(
  {
    fetch: (request) => app.fetch(request, env, executionCtx),
    port,
    hostname: "0.0.0.0",
  },
  (info) => {
    log.info("server_listening", { port: info.port, dataDir: process.env.DATA_DIR ?? "/data" });
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("server_shutdown", { signal });
    server.close(() => process.exit(0));
    // In-flight requests get a grace period, then the process exits hard.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
