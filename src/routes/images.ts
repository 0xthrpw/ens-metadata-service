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
import { CACHE_API_MAX_AGE, DEFAULT_IMAGE_HEADER } from "../constants";
import { cacheTagHeader, nameTag } from "../lib/cacheTags";
import { respondFromCache } from "../lib/responseCache";

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
      // Signals this is the placeholder, not the resolved asset, so preload
      // (and observability) can tell a fallback apart from a real warm.
      [DEFAULT_IMAGE_HEADER]: "1",
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
      // Fallback to the default image for failures that surface BEFORE the
      // response is committed: 404 (record not set) and 502 (record set but
      // the upstream fetch failed pre-stream — fetch threw, non-2xx, or
      // content-length > MAX). 415 stays a real error.
      //
      // NOTE: in the streaming path (upstream sent both content-type and
      // content-length) fetchImageBytes returns a 200 stream before the body
      // is read, so a mid-body upstream abort — or a content-length lie that
      // trips the size guard — can no longer be caught here: the client gets
      // a truncated 200, not the default image. This is the accepted
      // streaming tradeoff (TTFB win); every pre-stream failure still falls
      // back, and a partial body is never cached.
      if (err instanceof HttpError && (err.status === 404 || err.status === 502)) {
        return defaultImageResponse(kind, network, name) as never;
      }
      throw err;
    }
  });

  app.openapi(metaRoute(kind), async (c) => {
    return respondFromCache(caches.default, c.req.raw, c.executionCtx, async () => {
      const { network, name } = c.req.valid("param");
      const uri = await resolveUriCached(c.env, kind, network, name, c.executionCtx);
      const response = c.json({ name, network, uri, kind }, 200);
      response.headers.set("cache-control", `public, max-age=${CACHE_API_MAX_AGE}`);
      response.headers.set("cache-tag", cacheTagHeader(nameTag(network, name)));
      return response;
    }) as never;
  });

  return app;
}

export const avatarRoutes = buildImageRoutes("avatar");
export const headerRoutes = buildImageRoutes("header");
