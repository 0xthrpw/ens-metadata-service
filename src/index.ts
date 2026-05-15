import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { Scalar } from "@scalar/hono-api-reference";

import type { Env } from "./env";
import { HttpError } from "./lib/errors";
import { createLogger, log, parseLevel, setDefaultLevel } from "./lib/log";
import { createLlmsText } from "./lib/llms";
import { scalarTheme } from "./lib/scalarTheme";
import { registerRoutes } from "./routes";

const app = new OpenAPIHono<{ Bindings: Env }>();
const STATIC_CACHE_CONTROL = "public, max-age=3600";
const docsHandler = Scalar<{ Bindings: Env }>(scalarTheme);
const openApiConfig = {
  openapi: "3.1.0",
  info: {
    title: "ENS Metadata - Flarecloud",
    version: "0.1.0",
    description:
      "ENS metadata service on Cloudflare Workers. Serves JSON metadata, avatar, and header records.",
  },
} as const;

app.use("*", cors());

// Request correlation + one structured completion line per request. `reqId`
// is Cloudflare's cf-ray when present (cross-references Workers Logs with the
// dashboard) and a UUID otherwise (local/test). Level is env-driven per
// request; the logger is exposed to handlers via c.get("log").
app.use("*", async (c, next) => {
  const reqId = c.req.header("cf-ray") ?? crypto.randomUUID();
  const colo = (c.req.raw.cf as { colo?: string } | undefined)?.colo;
  const level = parseLevel(c.env.LOG_LEVEL);
  // Keep the module/default logger (used by the service layer + waitUntil
  // tasks) in sync with LOG_LEVEL, so debug diagnostics are reachable.
  setDefaultLevel(level);
  const reqLog = createLogger({ reqId, ...(colo ? { colo } : {}) }, level);
  c.set("log", reqLog);
  const start = Date.now();
  await next();
  const network = c.req.param("network");
  const name = c.req.param("name");
  reqLog.info("request_complete", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - start,
    ...(network ? { network } : {}),
    ...(name ? { name } : {}),
  });
});

registerRoutes(app);

const openApiDocument = app.getOpenAPI31Document(openApiConfig);
const llmsText = createLlmsText(openApiDocument);

function cached(response: Response): Response {
  response.headers.set("cache-control", STATIC_CACHE_CONTROL);
  return response;
}

app.get("/", async (c, next) => {
  const response = await docsHandler(c, next);
  return response ? cached(response) : c.notFound();
});
app.get("/docs", async (c, next) => {
  const response = await docsHandler(c, next);
  return response ? cached(response) : c.notFound();
});
app.get("/favicon.ico", () =>
  new Response(null, {
    status: 204,
    headers: { "cache-control": STATIC_CACHE_CONTROL },
  }),
);
app.get("/openapi.json", () =>
  new Response(JSON.stringify(openApiDocument), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": STATIC_CACHE_CONTROL,
    },
  }),
);
app.get("/llms.txt", (c) => {
  c.header("cache-control", STATIC_CACHE_CONTROL);
  return c.text(llmsText);
});

app.onError((err, c) => {
  const logger = c.get("log") ?? log;
  if (err instanceof HttpError) {
    // 5xx HttpErrors are expected upstream failures, not bugs — warn, and skip
    // 4xx entirely (highest-volume, normal client behavior; would be noise).
    if (err.status >= 500) {
      logger.warn("http_error", {
        method: c.req.method,
        path: c.req.path,
        status: err.status,
        code: err.code,
        err,
      });
    }
    return Response.json({ error: err.code ?? "error", message: err.message }, { status: err.status });
  }
  logger.error("unhandled_error", {
    method: c.req.method,
    path: c.req.path,
    err,
  });
  return Response.json({ error: "internal_error", message: "internal server error" }, { status: 500 });
});

export default app;
