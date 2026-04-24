import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { Scalar } from "@scalar/hono-api-reference";

import type { Env } from "./env";
import { HttpError } from "./lib/errors";
import { avatarRoutes, headerRoutes } from "./routes/images";
import { cacheInvalidateRoutes } from "./routes/cacheInvalidate";
import { metadataRoutes } from "./routes/metadata";
import { nameImageRoutes } from "./routes/nameImage";
import { queryNFTRoutes } from "./routes/queryNFT";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
});

app.use("*", cors());

app.route("/", avatarRoutes);
app.route("/", headerRoutes);
app.route("/", queryNFTRoutes);
app.route("/", nameImageRoutes);
app.route("/", metadataRoutes);
app.route("/", cacheInvalidateRoutes);

app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "ENS Metadata — Flarecloud",
    version: "0.1.0",
    description:
      "ENS metadata service on Cloudflare Workers. Serves JSON metadata, avatar, and header records.",
  },
});

app.get("/", Scalar({ url: "/openapi.json", pageTitle: "ENS Metadata" }));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return Response.json({ error: err.code ?? "error", message: err.message }, { status: err.status });
  }
  console.error(`unhandled error for ${c.req.method} ${c.req.path}:`, err);
  return Response.json({ error: "internal_error", message: "internal server error" }, { status: 500 });
});

export default app;
