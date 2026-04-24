import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AvatarKind } from "../services/avatarResolver";
import { fetchImageBytes, resolveUriCached } from "../services/image";
import { getNetwork } from "../lib/networks";
import { badRequest, HttpError } from "../lib/errors";
import { SVG_MIME } from "../lib/mime";
import defaultAvatarSvg from "../assets/default-avatar.svg";
import defaultHeaderSvg from "../assets/default-header.svg";
import {
  AvatarMetaSchema,
  ErrorSchema,
  NameParam,
  NetworkParam,
} from "../schemas";
import { CACHE_API_MAX_AGE } from "../constants";
import { cacheTagHeader, nameTag } from "../lib/cacheTags";

const DEFAULT_IMAGES: Record<AvatarKind, string> = {
  avatar: defaultAvatarSvg,
  header: defaultHeaderSvg,
};

function defaultImageResponse(
  kind: AvatarKind,
  network: string,
  name: string,
): Response {
  return new Response(DEFAULT_IMAGES[kind], {
    headers: {
      "content-type": SVG_MIME,
      "cache-control": `public, max-age=${CACHE_API_MAX_AGE}`,
      "cache-tag": cacheTagHeader(nameTag(network, name)),
    },
  });
}

function etagMatches(ifNoneMatch: string | null, etag: string | null): boolean {
  if (!ifNoneMatch || !etag) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .includes(etag.replace(/^W\//, ""));
}

function notModified(etag: string): Response {
  return new Response(null, {
    status: 304,
    headers: {
      etag,
      "cache-control": `public, max-age=${CACHE_API_MAX_AGE}`,
    },
  });
}

function imageRoute(kind: AvatarKind) {
  return createRoute({
    method: "get",
    path: `/{network}/${kind}/{name}`,
    tags: [kind],
    summary: `Get resolved ${kind} image bytes for an ENS name`,
    request: {
      params: z.object({ network: NetworkParam, name: NameParam }),
    },
    responses: {
      200: {
        description: "Image bytes",
        content: { "image/*": { schema: z.string().openapi({ format: "binary" }) } },
      },
      404: { description: "Record not set", content: { "application/json": { schema: ErrorSchema } } },
      502: { description: "Upstream fetch failed", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
}

function metaRoute(kind: AvatarKind) {
  return createRoute({
    method: "get",
    path: `/{network}/${kind}/{name}/meta`,
    tags: [kind],
    summary: `Get the resolved ${kind} URI without fetching the image`,
    request: {
      params: z.object({ network: NetworkParam, name: NameParam }),
    },
    responses: {
      200: {
        description: "Resolved URI metadata",
        content: { "application/json": { schema: AvatarMetaSchema } },
      },
      404: { description: "Record not set", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
}

function buildImageRoutes(kind: AvatarKind): OpenAPIHono<{ Bindings: Env }> {
  const app = new OpenAPIHono<{ Bindings: Env }>();

  app.openapi(imageRoute(kind), async (c) => {
    const ifNoneMatch = c.req.header("if-none-match") ?? null;
    const cache = caches.default;
    const cached = await cache.match(c.req.raw);
    if (cached) {
      const cachedEtag = cached.headers.get("etag");
      if (cachedEtag && etagMatches(ifNoneMatch, cachedEtag)) {
        return notModified(cachedEtag) as never;
      }
      return cached as never;
    }

    const { network, name } = c.req.valid("param");
    const networkConfig = getNetwork(c.env, network);
    if (!networkConfig) throw badRequest(`unknown network: ${network}`);
    try {
      const uri = await resolveUriCached(c.env, kind, network, name, c.executionCtx);
      const image = await fetchImageBytes(c.env, uri, c.executionCtx, {
        network: networkConfig,
        name,
      });

      const headers: Record<string, string> = {
        "content-type": image.contentType,
        "cache-control": `public, max-age=${CACHE_API_MAX_AGE}`,
        "cache-tag": cacheTagHeader(nameTag(network, name)),
      };
      if (image.etag) headers.etag = image.etag;

      const res = new Response(image.body, { headers });
      c.executionCtx.waitUntil(cache.put(c.req.raw, res.clone()).catch(() => {}));

      if (image.etag && etagMatches(ifNoneMatch, image.etag)) {
        return notModified(image.etag) as never;
      }
      return res as never;
    } catch (err) {
      // 404 = record not set; 502 = record set but upstream fetch failed.
      // Serve the default for both. 415 stays a real error.
      if (err instanceof HttpError && (err.status === 404 || err.status === 502)) {
        return defaultImageResponse(kind, network, name) as never;
      }
      throw err;
    }
  });

  app.openapi(metaRoute(kind), async (c) => {
    const { network, name } = c.req.valid("param");
    const uri = await resolveUriCached(c.env, kind, network, name, c.executionCtx);
    return c.json({ name, network, uri, kind }, 200);
  });

  return app;
}

export const avatarRoutes = buildImageRoutes("avatar");
export const headerRoutes = buildImageRoutes("header");
