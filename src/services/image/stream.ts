import { HttpError, upstream } from "../../lib/errors";
import { MAX_IMAGE_BYTES } from "../../constants";
import { assertUnderSizeLimit } from "./size";

// Caps a stream at `max` bytes without buffering. Applied to the raw upstream
// body *before* sanitization and `.tee()` so the cap — and the error it raises
// on overflow — propagates identically to both the client and R2 branches.
export function sizeLimitedStream(
  src: ReadableStream<Uint8Array>,
  max: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  const ts = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) {
        controller.error(upstream(`image exceeds size limit: >${max} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  // Equivalent to `src.pipeThrough(ts)`, but `pipeThrough` discards the
  // internal pipe promise — on overflow that promise rejects and surfaces as
  // an unhandled rejection. The consumer-facing error still reaches both tee
  // branches via `ts.readable`; this only swallows the redundant pipe-side
  // rejection.
  void src.pipeTo(ts.writable).catch(() => {});
  return ts.readable;
}

// Drains a teed branch into R2 in the background. Reads with an explicit
// reader (never `new Response(stream)`, which leaks an unhandled rejection in
// workerd when the stream errors) so a mid-stream size-guard error or upstream
// abort is contained here — and a partial/aborted body is never cached.
export async function teeBranchToR2(
  branch: ReadableStream<Uint8Array>,
  write: (bytes: ArrayBuffer) => Promise<void>,
  // Known output byte length (the non-SVG streaming path: bytes pass through
  // unchanged so length == content-length, already capped at MAX). Lets us
  // fill ONE preallocated buffer instead of buffering every chunk and then
  // copying into a second contiguous buffer — avoids ~2x peak memory on
  // large images. Omitted for the sanitized-SVG path, where HTMLRewriter
  // changes the length (and SVG payloads are small anyway).
  expectedLength?: number,
): Promise<void> {
  const reader = branch.getReader();

  if (expectedLength !== undefined) {
    const out = new Uint8Array(expectedLength);
    let offset = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        if (offset + value.byteLength > expectedLength) {
          // Body longer than its declared length — malformed; don't cache.
          reader.releaseLock();
          return;
        }
        out.set(value, offset);
        offset += value.byteLength;
      }
    } catch {
      reader.releaseLock();
      return; // overflow / abort — leave the cache cold rather than partial
    }
    reader.releaseLock();
    try {
      // Exact length is the common case (no copy); a short body (server
      // under-declared) gets a one-off sized copy.
      await write(
        offset === expectedLength
          ? (out.buffer as ArrayBuffer)
          : out.buffer.slice(0, offset),
      );
    } catch {
      /* best-effort background cache write */
    }
    return;
  }

  // Unknown output length (sanitized SVG): buffer chunks, then concatenate.
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } catch {
    reader.releaseLock();
    return; // overflow / abort — leave the cache cold rather than partial
  }
  reader.releaseLock();
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    await write(out.buffer as ArrayBuffer);
  } catch {
    /* best-effort background cache write */
  }
}

export async function readStreamUnderSizeLimit(
  src: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<ArrayBuffer> {
  if (!src) return new ArrayBuffer(0);

  const reader = src.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      seen += value.byteLength;
      if (seen > max) {
        const err = upstream(`image exceeds size limit: >${max} bytes`);
        await reader.cancel(err).catch(() => {});
        throw err;
      }

      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel(err).catch(() => {});
    if (err instanceof HttpError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw upstream(`image fetch failed: ${msg}`, err);
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(seen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer as ArrayBuffer;
}

export async function readResponseBytes(
  res: Response,
  useStreamReader: boolean,
): Promise<ArrayBuffer> {
  if (useStreamReader) {
    return readStreamUnderSizeLimit(res.body, MAX_IMAGE_BYTES);
  }

  try {
    const bytes = await res.arrayBuffer();
    assertUnderSizeLimit(bytes.byteLength);
    return bytes;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw upstream(`image fetch failed: ${msg}`, err);
  }
}
