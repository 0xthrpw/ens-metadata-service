import { decodeDataUri } from "../avatarResolver";
import { sanitizeIfSvg } from "./sanitizeBytes";
import type { ImageResult } from "./types";

export function handleData(uri: string): Promise<ImageResult> {
  const { bytes, mime } = decodeDataUri(uri);
  return sanitizeIfSvg(bytes.buffer as ArrayBuffer, mime);
}
