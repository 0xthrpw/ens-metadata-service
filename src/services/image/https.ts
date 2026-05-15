import type { Env } from "../../env";
import { upstream } from "../../lib/errors";
import { getHttps, headHttps, putHttps } from "../../storage/r2Cache";
import { isSvgMime, sniffMime, SVG_MIME } from "../../lib/mime";
import { sanitizeSvgStream, SANITIZER_VERSION } from "../sanitize";
import { log } from "../../lib/log";
import { HTTPS_IMAGE_TIMEOUT_MS, MAX_IMAGE_BYTES } from "../../constants";
import { advertisedLengthExceeds, assertUnderSizeLimit } from "./size";
import { readResponseBytes, sizeLimitedStream, teeBranchToR2 } from "./stream";
import { sanitizeIfSvg, svgVersionedEtag } from "./sanitizeBytes";
import type { ImageResult } from "./types";

export async function handleHttps(
  env: Env,
  url: string,
  ctx: ExecutionContext,
): Promise<ImageResult> {
  const rawValidators = await headHttps(env, url);
  const validators =
    rawValidators &&
    isSvgMime(rawValidators.contentType ?? "") &&
    rawValidators.sanitizerVersion !== SANITIZER_VERSION
      ? null
      : rawValidators;
  const headers: HeadersInit = {};
  if (validators?.etag) headers["If-None-Match"] = validators.etag;
  if (validators?.lastModified) headers["If-Modified-Since"] = validators.lastModified;
  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      cf: { cacheTtl: 3600, cacheEverything: true },
      signal: AbortSignal.timeout(HTTPS_IMAGE_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw upstream(`image fetch failed: ${msg}`, err);
  }
  if (res.status === 304 && validators) {
    const hit = await getHttps(env, url);
    if (hit) {
      log.debug("r2_image_revalidated", { scheme: "https" });
      assertUnderSizeLimit(hit.bytes.byteLength);
      if (hit.sanitized || !isSvgMime(hit.contentType)) {
        const servedEtag = isSvgMime(hit.contentType) && hit.etag ? svgVersionedEtag(hit.etag) : hit.etag;
        return { body: hit.bytes, contentType: hit.contentType, etag: servedEtag };
      }
      const sanitized = await sanitizeIfSvg(hit.bytes, hit.contentType);
      const sourceEtag = hit.etag;
      ctx.waitUntil(
        putHttps(env, url, sanitized.body as ArrayBuffer, sanitized.contentType, sourceEtag, hit.lastModified, true, SANITIZER_VERSION),
      );
      const svgEtag = sourceEtag ? svgVersionedEtag(sourceEtag) : undefined;
      return { ...sanitized, etag: svgEtag };
    }
    throw upstream("cached image disappeared between head and get");
  }
  if (!res.ok) throw upstream(`image fetch failed: ${res.status}`);
  log.debug("r2_image_miss", { scheme: "https" });
  if (advertisedLengthExceeds(res.headers, MAX_IMAGE_BYTES)) {
    throw upstream(
      `image too large: content-length ${res.headers.get("content-length")} > ${MAX_IMAGE_BYTES}`,
    );
  }
  const headerType = res.headers.get("content-type");
  const etag = res.headers.get("etag") ?? undefined;
  const lastModified = res.headers.get("last-modified") ?? undefined;
  const hasDeclaredLength = res.headers.has("content-length");

  // Unknown content-type or no declared length: must buffer to mime-sniff.
  if (!headerType || !hasDeclaredLength) {
    const rawBytes = await readResponseBytes(res, true);
    const rawType = headerType ?? sniffMime(new Uint8Array(rawBytes));
    const image = await sanitizeIfSvg(rawBytes, rawType);
    const stored = image.body as ArrayBuffer;
    const isSvg = isSvgMime(image.contentType);
    ctx.waitUntil(
      putHttps(
        env,
        url,
        stored,
        image.contentType,
        etag,
        lastModified,
        isSvg,
        isSvg ? SANITIZER_VERSION : undefined,
      ),
    );
    const servedEtag = isSvg && etag ? svgVersionedEtag(etag) : etag;
    return { ...image, etag: servedEtag };
  }

  // Streaming path: known content-type + declared length.
  if (!res.body) throw upstream("https response has no body");
  const limited = sizeLimitedStream(res.body, MAX_IMAGE_BYTES);
  const isSvg = isSvgMime(headerType);
  const outStream = isSvg ? sanitizeSvgStream(limited) : limited;
  const outType = isSvg ? SVG_MIME : headerType;
  const [toClient, toR2] = outStream.tee();
  // Non-SVG bytes pass through unchanged, so the R2 copy length equals the
  // (already <= MAX) content-length — lets teeBranchToR2 use one buffer.
  const cl = Number(res.headers.get("content-length"));
  const r2Length =
    !isSvg && Number.isFinite(cl) && cl >= 0 ? cl : undefined;
  ctx.waitUntil(
    teeBranchToR2(
      toR2,
      (bytes) =>
        putHttps(
          env,
          url,
          bytes,
          outType,
          etag,
          lastModified,
          isSvg,
          isSvg ? SANITIZER_VERSION : undefined,
        ),
      r2Length,
    ),
  );
  const servedEtag = isSvg && etag ? svgVersionedEtag(etag) : etag;
  return { body: toClient, contentType: outType, etag: servedEtag };
}
