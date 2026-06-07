import type { Env } from "../../env";
import { badRequest, upstream } from "../../lib/errors";
import { fetchIpfs, parseIpfs, type IpfsRef } from "../ipfs";
import { getIpfs, putIpfs } from "../../storage/r2Cache";
import { isSvgMime, sniffMime, SVG_MIME } from "../../lib/mime";
import { sanitizeSvgStream, SANITIZER_VERSION } from "../sanitize";
import { log } from "../../lib/log";
import { MAX_IMAGE_BYTES } from "../../constants";
import { advertisedLengthExceeds, ipfsEtag } from "./size";
import { readResponseBytes, sizeLimitedStream, teeBranchToR2 } from "./stream";
import { sanitizeIfSvg } from "./sanitizeBytes";
import type { ImageResult } from "./types";

export async function handleIpfs(
  env: Env,
  uri: string,
  ctx: ExecutionContext,
): Promise<ImageResult> {
  const ref = parseIpfs(uri);
  if (!ref) throw badRequest(`invalid ipfs URI: ${uri}`);
  const etag = ipfsEtag(ref);
  const hit = await getIpfs(env, ref);
  if (hit && hit.bytes.byteLength <= MAX_IMAGE_BYTES) {
    if (!isSvgMime(hit.contentType)) {
      log.debug("r2_image_hit", { scheme: "ipfs" });
      return { body: hit.bytes, contentType: hit.contentType, etag };
    }
    if (hit.sanitized && hit.sanitizerVersion === SANITIZER_VERSION) {
      log.debug("r2_image_hit", { scheme: "ipfs" });
      return { body: hit.bytes, contentType: hit.contentType, etag };
    }
  }
  log.debug("r2_image_miss", { scheme: "ipfs" });
  const res = await fetchIpfs(env, ref);
  if (advertisedLengthExceeds(res.headers, MAX_IMAGE_BYTES)) {
    throw upstream(
      `image too large: content-length ${res.headers.get("content-length")} > ${MAX_IMAGE_BYTES}`,
    );
  }
  const headerType = res.headers.get("content-type");
  const hasDeclaredLength = res.headers.has("content-length");

  // Unknown content-type or no declared length: must buffer to mime-sniff.
  if (!headerType || !hasDeclaredLength) {
    const rawBytes = await readResponseBytes(res, true);
    const rawType = headerType ?? sniffMime(new Uint8Array(rawBytes));
    const image = await sanitizeIfSvg(rawBytes, rawType);
    const stored = image.body as ArrayBuffer;
    const isIpfsSvg = isSvgMime(image.contentType);
    ctx.waitUntil(
      putIpfs(env, ref, stored, image.contentType, isIpfsSvg, isIpfsSvg ? SANITIZER_VERSION : undefined),
    );
    return { ...image, etag };
  }

  // Streaming path: known content-type + declared length. Stream to the
  // client immediately while the R2 write drains the teed branch in the
  // background — first byte no longer waits on full download + sanitize.
  if (!res.body) throw upstream("ipfs response has no body");
  const limited = sizeLimitedStream(res.body, MAX_IMAGE_BYTES);
  const isIpfsSvg = isSvgMime(headerType);
  const outStream = isIpfsSvg ? sanitizeSvgStream(limited) : limited;
  const outType = isIpfsSvg ? SVG_MIME : headerType;
  const [toClient, toR2] = outStream.tee();
  // Non-SVG bytes pass through unchanged, so the R2 copy length equals the
  // (already <= MAX) content-length — lets teeBranchToR2 use one buffer.
  const cl = Number(res.headers.get("content-length"));
  const r2Length =
    !isIpfsSvg && Number.isFinite(cl) && cl >= 0 ? cl : undefined;
  ctx.waitUntil(
    teeBranchToR2(
      toR2,
      (bytes) =>
        putIpfs(
          env,
          ref,
          bytes,
          outType,
          isIpfsSvg,
          isIpfsSvg ? SANITIZER_VERSION : undefined,
        ),
      r2Length,
    ),
  );
  return { body: toClient, contentType: outType, etag };
}

// Store-only IPFS warm used by the preload endpoint. Unlike handleIpfs it
// reuses a usable cache hit, otherwise fetches + sanitizes and *awaits* the
// R2 write (no streaming/tee) so the caller gets an accurate byte count.
export async function warmIpfsToR2(
  env: Env,
  ref: IpfsRef,
): Promise<{ bytes: number; contentType: string; fromCache: boolean }> {
  const hit = await getIpfs(env, ref);
  if (hit && hit.bytes.byteLength <= MAX_IMAGE_BYTES) {
    if (
      !isSvgMime(hit.contentType) ||
      (hit.sanitized && hit.sanitizerVersion === SANITIZER_VERSION)
    ) {
      return {
        bytes: hit.bytes.byteLength,
        contentType: hit.contentType,
        fromCache: true,
      };
    }
  }
  const res = await fetchIpfs(env, ref);
  if (advertisedLengthExceeds(res.headers, MAX_IMAGE_BYTES)) {
    throw upstream(
      `image too large: content-length ${res.headers.get("content-length")} > ${MAX_IMAGE_BYTES}`,
    );
  }
  const headerType = res.headers.get("content-type");
  const rawBytes = await readResponseBytes(res, true);
  const rawType = headerType ?? sniffMime(new Uint8Array(rawBytes));
  const image = await sanitizeIfSvg(rawBytes, rawType);
  const stored = image.body as ArrayBuffer;
  const isIpfsSvg = isSvgMime(image.contentType);
  await putIpfs(
    env,
    ref,
    stored,
    image.contentType,
    isIpfsSvg,
    isIpfsSvg ? SANITIZER_VERSION : undefined,
  );
  return {
    bytes: stored.byteLength,
    contentType: image.contentType,
    fromCache: false,
  };
}
