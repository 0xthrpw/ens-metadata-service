import { upstream } from "../../lib/errors";
import { MAX_IMAGE_BYTES } from "../../constants";

export function ipfsEtag(ref: { cid: string; path: string }): string {
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

export function advertisedLengthExceeds(headers: Headers, max: number): boolean {
  const raw = headers.get("content-length");
  if (!raw) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > max;
}
