import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../env";
import { avatarRoutes, headerRoutes } from "./images";
import { metadataRoutes } from "./metadata";
import { nameImageRoutes } from "./nameImage";
import { queryNFTRoutes } from "./queryNFT";
import { adminRoutes } from "./admin";

// Single place that mounts every route module + registers shared OpenAPI
// components, so src/index.ts stays focused on app/middleware wiring.
export function registerRoutes(app: OpenAPIHono<{ Bindings: Env }>): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
  });

  app.route("/", avatarRoutes);
  app.route("/", headerRoutes);
  app.route("/", queryNFTRoutes);
  app.route("/", nameImageRoutes);
  app.route("/", metadataRoutes);
  app.route("/", adminRoutes);
}
