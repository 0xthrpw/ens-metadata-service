import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import type { Env } from "../../src/env";
import { MAX_IMAGE_BYTES } from "../../src/constants";
import { SVG_MIME } from "../../src/lib/mime";
import { fetchImageBytes } from "../../src/services/image";
import { SANITIZER_VERSION } from "../../src/services/sanitize";
import { getHttps, getIpfs } from "../../src/storage/r2Cache";
import type { IpfsRef } from "../../src/services/ipfs";

const testEnv = env as unknown as Env;
const originalIpfsGateways = testEnv.IPFS_GATEWAYS;
const encoder = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= chunks.length) {
        c.close();
        return;
      }
      c.enqueue(chunks[i++]!);
    },
  });
}

async function drain(result: {
  body: ReadableStream<Uint8Array> | ArrayBuffer;
}): Promise<Uint8Array> {
  const buf =
    result.body instanceof ArrayBuffer
      ? result.body
      : await new Response(result.body).arrayBuffer();
  return new Uint8Array(buf);
}

beforeEach(() => {
  testEnv.IPFS_GATEWAYS = "https://gateway.example";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  testEnv.IPFS_GATEWAYS = originalIpfsGateways;
});

describe("fetchImageBytes streaming path", () => {
  it("streams a known non-SVG response and writes R2 in the background", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(streamOf([bytes]), {
        headers: {
          "content-type": "image/png",
          "content-length": String(bytes.byteLength),
        },
      }),
    );

    const url = "https://cdn.example.test/streamed.png";
    const ctx = createExecutionContext();
    const result = await fetchImageBytes(testEnv, url, ctx);

    // Observable proof streaming is active: body is a stream, not a buffer.
    expect(result.body).toBeInstanceOf(ReadableStream);
    expect(result.contentType).toBe("image/png");
    expect(await drain(result)).toEqual(bytes);

    await waitOnExecutionContext(ctx);
    const cached = await getHttps(testEnv, url);
    expect(cached).not.toBeNull();
    expect(new Uint8Array(cached!.bytes)).toEqual(bytes);
    expect(cached!.sanitized).toBe(false);
    expect(cached!.sanitizerVersion).toBeUndefined();
    expect(cached!.contentType).toBe("image/png");
  });

  it("stream-sanitizes a known SVG response and stores the sanitized copy", async () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>`;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(streamOf([encoder.encode(dirty)]), {
        headers: {
          "content-type": "image/svg+xml",
          "content-length": String(encoder.encode(dirty).byteLength),
          etag: '"src-svg"',
        },
      }),
    );

    const url = "https://cdn.example.test/streamed.svg";
    const ctx = createExecutionContext();
    const result = await fetchImageBytes(testEnv, url, ctx);

    expect(result.body).toBeInstanceOf(ReadableStream);
    expect(result.contentType).toBe(SVG_MIME);
    const text = new TextDecoder().decode(await drain(result));
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("alert(1)");
    expect(text).toContain("<svg");

    await waitOnExecutionContext(ctx);
    const cached = await getHttps(testEnv, url);
    expect(cached).not.toBeNull();
    expect(cached!.sanitized).toBe(true);
    expect(cached!.sanitizerVersion).toBe(SANITIZER_VERSION);
    expect(new TextDecoder().decode(cached!.bytes)).not.toContain("<script>");
  });

  it("returns a versioned ETag for streamed SVG responses", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(streamOf([encoder.encode(svg)]), {
        headers: {
          "content-type": "image/svg+xml",
          "content-length": String(encoder.encode(svg).byteLength),
          etag: '"abc"',
        },
      }),
    );

    const ctx = createExecutionContext();
    const result = await fetchImageBytes(
      testEnv,
      "https://cdn.example.test/etag.svg",
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(result.etag).toBe(`"abc-sv${SANITIZER_VERSION}"`);
  });

  it("errors mid-stream on oversize and writes no partial R2 entry", async () => {
    const putSpy = vi.spyOn(testEnv.IPFS_CACHE, "put");
    // content-length lies small so advertisedLengthExceeds passes; the body
    // overflows once streaming, tripping the in-stream size guard.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        streamOf([new Uint8Array(MAX_IMAGE_BYTES), Uint8Array.from([1, 2, 3])]),
        {
          headers: { "content-type": "image/png", "content-length": "10" },
        },
      ),
    );

    const url = "https://cdn.example.test/oversize.png";
    const ctx = createExecutionContext();
    const result = await fetchImageBytes(testEnv, url, ctx);

    const reader = (result.body as ReadableStream<Uint8Array>).getReader();
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      })(),
    ).rejects.toThrow(/image exceeds size limit/);

    await waitOnExecutionContext(ctx);
    expect(putSpy).not.toHaveBeenCalled();
    expect(await getHttps(testEnv, url)).toBeNull();
  });

  it("streams + sanitizes IPNS without caching and without an ETag", async () => {
    const putSpy = vi.spyOn(testEnv.IPFS_CACHE, "put");
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script><g/></svg>`;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(streamOf([encoder.encode(dirty)]), {
        headers: {
          "content-type": "image/svg+xml",
          "content-length": String(encoder.encode(dirty).byteLength),
        },
      }),
    );

    const ctx = createExecutionContext();
    const result = await fetchImageBytes(
      testEnv,
      "ipns://k51example/profile.svg",
      ctx,
    );

    expect(result.body).toBeInstanceOf(ReadableStream);
    expect(result.contentType).toBe(SVG_MIME);
    expect(result.etag).toBeUndefined();
    const text = new TextDecoder().decode(await drain(result));
    expect(text).not.toContain("<script>");

    await waitOnExecutionContext(ctx);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("tees safely: consuming only the client branch does not stall the R2 write", async () => {
    const bytes = Uint8Array.from([9, 8, 7, 6]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(streamOf([bytes]), {
        headers: {
          "content-type": "image/png",
          "content-length": String(bytes.byteLength),
        },
      }),
    );

    const url = "https://cdn.example.test/tee.png";
    const ctx = createExecutionContext();
    const result = await fetchImageBytes(testEnv, url, ctx);

    // Drain only the client branch, then ensure the background R2 write
    // (the other tee branch) still completes within waitUntil.
    expect(await drain(result)).toEqual(bytes);
    await waitOnExecutionContext(ctx);

    const cached = await getHttps(testEnv, url);
    expect(cached).not.toBeNull();
    expect(new Uint8Array(cached!.bytes)).toEqual(bytes);
  });

  it("falls back to a buffered ArrayBuffer when content-length is absent", async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(streamOf([bytes]), {
        headers: { "content-type": "image/png" }, // no content-length
      }),
    );

    const ctx = createExecutionContext();
    const result = await fetchImageBytes(
      testEnv,
      "https://cdn.example.test/no-length.png",
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Mime-sniff fallback must keep buffering (regression guard).
    expect(result.body).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result.body as ArrayBuffer)).toEqual(bytes);
  });

  it("streams a known IPFS response and writes R2 in the background", async () => {
    const ref: IpfsRef = {
      cid: "QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A",
      path: "/streaming-test.png",
    };
    const bytes = Uint8Array.from([10, 20, 30]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(streamOf([bytes]), {
        headers: {
          "content-type": "image/png",
          "content-length": String(bytes.byteLength),
        },
      }),
    );

    const ctx = createExecutionContext();
    const result = await fetchImageBytes(
      testEnv,
      `ipfs://${ref.cid}${ref.path}`,
      ctx,
    );

    expect(result.body).toBeInstanceOf(ReadableStream);
    expect(await drain(result)).toEqual(bytes);

    await waitOnExecutionContext(ctx);
    const cached = await getIpfs(testEnv, ref);
    expect(cached).not.toBeNull();
    expect(new Uint8Array(cached!.bytes)).toEqual(bytes);
  });
});
