import type { Env } from "../../env";
import { badRequest, upstream } from "../../lib/errors";
import { fetchIpns, parseIpns } from "../ipfs";
import { isSvgMime, sniffMime, SVG_MIME } from "../../lib/mime";
import { sanitizeSvgStream } from "../sanitize";
import { MAX_IMAGE_BYTES } from "../../constants";
import { advertisedLengthExceeds } from "./size";
import { readResponseBytes, sizeLimitedStream } from "./stream";
import { sanitizeIfSvg } from "./sanitizeBytes";
import type { ImageResult } from "./types";

export async function handleIpns(env: Env, uri: string): Promise<ImageResult> {
  const ref = parseIpns(uri);
  if (!ref) throw badRequest(`invalid ipns URI: ${uri}`);
  const res = await fetchIpns(env, ref);
  if (advertisedLengthExceeds(res.headers, MAX_IMAGE_BYTES)) {
    throw upstream(
      `image too large: content-length ${res.headers.get("content-length")} > ${MAX_IMAGE_BYTES}`,
    );
  }
  const headerType = res.headers.get("content-type");
  const hasDeclaredLength = res.headers.has("content-length");

  // IPNS is mutable and deliberately uncached, so there is no R2 tee — but
  // we can still stream + sanitize to the client instead of buffering.
  if (!headerType || !hasDeclaredLength) {
    const rawBytes = await readResponseBytes(res, true);
    const rawType = headerType ?? sniffMime(new Uint8Array(rawBytes));
    return sanitizeIfSvg(rawBytes, rawType);
  }
  if (!res.body) throw upstream("ipns response has no body");
  const limited = sizeLimitedStream(res.body, MAX_IMAGE_BYTES);
  const isSvg = isSvgMime(headerType);
  return {
    body: isSvg ? sanitizeSvgStream(limited) : limited,
    contentType: isSvg ? SVG_MIME : headerType,
  };
}
