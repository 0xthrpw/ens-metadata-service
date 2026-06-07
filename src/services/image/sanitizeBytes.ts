import { isSvgMime, SVG_MIME } from "../../lib/mime";
import { sanitizeSvg, SANITIZER_VERSION } from "../sanitize";
import type { ImageResult } from "./types";

export async function sanitizeIfSvg(
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

export function svgVersionedEtag(sourceEtag: string): string {
  const bare = sourceEtag.replace(/^"|"$/g, "");
  return `"${bare}-sv${SANITIZER_VERSION}"`;
}
