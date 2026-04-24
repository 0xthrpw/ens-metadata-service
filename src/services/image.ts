import type { Env } from "../env";
import { getNetwork, type NetworkConfig } from "../lib/networks";
import { badRequest, HttpError, notFound, upstream } from "../lib/errors";
import {
  classifyUri,
  decodeDataUri,
  resolveRecord,
  type AvatarKind,
} from "./avatarResolver";
import { createClient, getOwner, normalizeName } from "./ens";
import { fetchIpfs, parseIpfs } from "./ipfs";
import { resolveNftAvatar } from "./nftAvatar";
import { sanitizeSvg } from "./sanitize";
import { deleteResolved, getResolved, putResolved } from "../storage/kvCache";
import { getHttps, getIpfs, headHttps, putHttps, putIpfs } from "../storage/r2Cache";
import { isSvgMime, sniffMime, SVG_MIME } from "../lib/mime";
import { HTTPS_IMAGE_TIMEOUT_MS, MAX_IMAGE_BYTES } from "../constants";

// Context the eip155 (NFT) image path needs to look up the wallet that
// "owns" the avatar — i.e. the address the ENS name resolves to. Other URI
// schemes ignore this entirely.
export type EnsContext = {
  network: NetworkConfig;
  name: string;
};

export type ImageResult = {
  body: ReadableStream<Uint8Array> | ArrayBuffer;
  contentType: string;
  etag?: string;
};

function ipfsEtag(ref: { cid: string; path: string }): string {
  return `"ipfs:${ref.cid}${ref.path}"`;
}

export function assertUnderSizeLimit(
  byteLength: number,
  max: number = MAX_IMAGE_BYTES,
): void {
  if (byteLength > max) {
    throw upstream(`image exceeds size limit: ${byteLength} > ${max} bytes`);
  }
}

function advertisedLengthExceeds(headers: Headers, max: number): boolean {
  const raw = headers.get("content-length");
  if (!raw) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > max;
}

async function sanitizeIfSvg(
  bytes: ArrayBuffer,
  contentType: string,
): Promise<ImageResult> {
  if (!isSvgMime(contentType)) return { body: bytes, contentType };
  const text = new TextDecoder().decode(bytes);
  const clean = await sanitizeSvg(text);
  return {
    body: new TextEncoder().encode(clean).buffer as ArrayBuffer,
    contentType: SVG_MIME,
  };
}

export async function resolveUriCached(
  env: Env,
  kind: AvatarKind,
  networkName: string,
  name: string,
  ctx: ExecutionContext,
): Promise<string> {
  const cached = await getResolved(env, kind, networkName, name);
  if (cached?.fresh) return cached.uri;

  const network = getNetwork(env, networkName);
  if (!network) throw badRequest(`unknown network: ${networkName}`);

  if (cached) {
    ctx.waitUntil(
      (async () => {
        try {
          const uri = await resolveRecord(network, kind, name);
          await putResolved(env, kind, networkName, name, uri);
        } catch (err) {
          if (err instanceof HttpError && err.status === 404) {
            await deleteResolved(env, kind, networkName, name);
            return;
          }
          console.error(
            `stale revalidation failed for ${kind}:${networkName}:${name}:`,
            err,
          );
        }
      })(),
    );
    return cached.uri;
  }

  const uri = await resolveRecord(network, kind, name);
  ctx.waitUntil(putResolved(env, kind, networkName, name, uri));
  return uri;
}

export async function fetchImageBytes(
  env: Env,
  uri: string,
  ctx: ExecutionContext,
  ensContext?: EnsContext,
): Promise<ImageResult> {
  const classified = classifyUri(uri);

  switch (classified.kind) {
    case "data": {
      const { bytes, mime } = decodeDataUri(uri);
      return sanitizeIfSvg(bytes.buffer as ArrayBuffer, mime);
    }

    case "ipfs": {
      const ref = parseIpfs(uri);
      if (!ref) throw badRequest(`invalid ipfs URI: ${uri}`);
      const etag = ipfsEtag(ref);
      const hit = await getIpfs(env, ref);
      if (hit && hit.bytes.byteLength <= MAX_IMAGE_BYTES) {
        if (hit.sanitized || !isSvgMime(hit.contentType)) {
          return { body: hit.bytes, contentType: hit.contentType, etag };
        }
        const sanitized = await sanitizeIfSvg(hit.bytes, hit.contentType);
        return { ...sanitized, etag };
      }
      const res = await fetchIpfs(env, ref);
      if (advertisedLengthExceeds(res.headers, MAX_IMAGE_BYTES)) {
        throw upstream(
          `image too large: content-length ${res.headers.get("content-length")} > ${MAX_IMAGE_BYTES}`,
        );
      }
      const headerType = res.headers.get("content-type");
      const rawBytes = await res.arrayBuffer();
      assertUnderSizeLimit(rawBytes.byteLength);
      const rawType = headerType ?? sniffMime(new Uint8Array(rawBytes));
      const image = await sanitizeIfSvg(rawBytes, rawType);
      const stored = image.body as ArrayBuffer;
      ctx.waitUntil(
        putIpfs(env, ref, stored, image.contentType, isSvgMime(image.contentType)),
      );
      return { ...image, etag };
    }

    case "https": {
      const validators = await headHttps(env, classified.url);
      const headers: HeadersInit = {};
      if (validators?.etag) headers["If-None-Match"] = validators.etag;
      if (validators?.lastModified) headers["If-Modified-Since"] = validators.lastModified;
      const ctrl = new AbortController();
      const headerTimeout = setTimeout(
        () => ctrl.abort(),
        HTTPS_IMAGE_TIMEOUT_MS,
      );
      let res: Response;
      try {
        res = await fetch(classified.url, {
          headers,
          cf: { cacheTtl: 3600, cacheEverything: true },
          signal: ctrl.signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw upstream(`image fetch failed: ${msg}`, err);
      } finally {
        clearTimeout(headerTimeout);
      }
      if (res.status === 304 && validators) {
        const hit = await getHttps(env, classified.url);
        if (hit) {
          assertUnderSizeLimit(hit.bytes.byteLength);
          if (hit.sanitized || !isSvgMime(hit.contentType)) {
            return { body: hit.bytes, contentType: hit.contentType, etag: hit.etag };
          }
          const sanitized = await sanitizeIfSvg(hit.bytes, hit.contentType);
          return { ...sanitized, etag: hit.etag };
        }
        throw upstream("cached image disappeared between head and get");
      }
      if (!res.ok) throw upstream(`image fetch failed: ${res.status}`);
      if (advertisedLengthExceeds(res.headers, MAX_IMAGE_BYTES)) {
        throw upstream(
          `image too large: content-length ${res.headers.get("content-length")} > ${MAX_IMAGE_BYTES}`,
        );
      }
      const headerType = res.headers.get("content-type");
      const etag = res.headers.get("etag") ?? undefined;
      const lastModified = res.headers.get("last-modified") ?? undefined;
      const rawBytes = await res.arrayBuffer();
      assertUnderSizeLimit(rawBytes.byteLength);
      const rawType = headerType ?? sniffMime(new Uint8Array(rawBytes));
      const image = await sanitizeIfSvg(rawBytes, rawType);
      const stored = image.body as ArrayBuffer;
      ctx.waitUntil(
        putHttps(
          env,
          classified.url,
          stored,
          image.contentType,
          etag,
          lastModified,
          isSvgMime(image.contentType),
        ),
      );
      return { ...image, etag };
    }

    case "eip155": {
      // Resolve the NFT (tokenURI → metadata JSON → image URI) and recurse
      // through this same function so the resolved image goes through the
      // existing IPFS/HTTPS/data caching paths. Ownership check uses the
      // address the ENS name resolves to. Without an ensContext (debug-only
      // callers) we skip the check; otherwise a missing addr record makes
      // verification impossible and we treat it as not-found.
      let expectedOwner: `0x${string}` | null = null;
      if (ensContext) {
        expectedOwner = await getOwner(
          createClient(ensContext.network),
          normalizeName(ensContext.name),
        );
        if (!expectedOwner) {
          throw notFound(
            `${ensContext.name} has no addr record; cannot verify NFT avatar ownership`,
          );
        }
      }
      const meta = await resolveNftAvatar(
        env,
        {
          chainId: classified.chainId,
          namespace: classified.namespace,
          contract: classified.contract,
          tokenId: classified.tokenId,
        },
        expectedOwner,
      );
      // Pass undefined ensContext on recursion — the inner image URI is no
      // longer ENS-bound and shouldn't trigger another ownership check.
      return fetchImageBytes(env, meta.imageUri, ctx);
    }
  }
}
