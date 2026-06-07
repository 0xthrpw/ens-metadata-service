import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../../src/env";
import { HTTPS_IMAGE_TIMEOUT_MS, MAX_IMAGE_BYTES } from "../../src/constants";
import { SVG_MIME } from "../../src/lib/mime";
import { assertUnderSizeLimit } from "../../src/services/image";
import { fetchImageBytes } from "../../src/services/image";

const PNG_BYTES = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
]);
const VALID_CID = "QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A";
const testEnv = env as unknown as Env;
const originalIpfsGateways = testEnv.IPFS_GATEWAYS;

function trackArrayBufferCalls(
  res: Response,
  calls: { count: number },
): Response {
  Object.defineProperty(res, "arrayBuffer", {
    value: async () => {
      calls.count += 1;
      return Response.prototype.arrayBuffer.call(res);
    },
  });
  return res;
}

function chunkStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]!);
    },
  });
}

function overflowStream(): {
  stream: ReadableStream<Uint8Array>;
  pullCount: () => number;
  reachedEof: () => boolean;
  wasCanceled: () => boolean;
} {
  const chunks = [
    new Uint8Array(MAX_IMAGE_BYTES),
    Uint8Array.from([0x01]),
    Uint8Array.from([0x02]),
  ];
  let index = 0;
  let pulls = 0;
  let canceled = false;
  let eof = false;

  return {
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (index >= chunks.length) {
          eof = true;
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]!);
      },
      cancel() {
        canceled = true;
      },
    }),
    pullCount: () => pulls,
    reachedEof: () => eof,
    wasCanceled: () => canceled,
  };
}

function abortableStream(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = () => {
        controller.error(
          signal.reason ?? new DOMException("The operation was aborted", "AbortError"),
        );
      };
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    },
  });
}

beforeEach(() => {
  testEnv.IPFS_GATEWAYS = "https://gateway.example";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  testEnv.IPFS_GATEWAYS = originalIpfsGateways;
});

describe("assertUnderSizeLimit", () => {
  it("accepts payloads at or under the limit", () => {
    expect(() => assertUnderSizeLimit(0)).not.toThrow();
    expect(() => assertUnderSizeLimit(MAX_IMAGE_BYTES)).not.toThrow();
  });

  it("throws an upstream error when the payload is larger than the limit", () => {
    expect(() => assertUnderSizeLimit(MAX_IMAGE_BYTES + 1)).toThrowError(
      /image exceeds size limit/,
    );
  });

  it("respects a custom limit override", () => {
    expect(() => assertUnderSizeLimit(101, 100)).toThrowError(
      /image exceeds size limit/,
    );
    expect(() => assertUnderSizeLimit(100, 100)).not.toThrow();
  });
});

describe("fetchImageBytes", () => {
  it("passes a timeout-backed signal to HTTPS fetches", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", {
        headers: {
          "content-type": "image/png",
          "content-length": "2",
        },
      }),
    );

    const ctx = createExecutionContext();
    const image = await fetchImageBytes(
      testEnv,
      "https://example.com/avatar-timeout-signal.png",
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(timeoutSpy).toHaveBeenCalledWith(HTTPS_IMAGE_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://example.com/avatar-timeout-signal.png",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(
      timeoutSpy.mock.results[0]?.value,
    );
    expect(image.contentType).toBe("image/png");
    // Known content-type + content-length now streams to the client.
    expect(image.body).toBeInstanceOf(ReadableStream);
  });

  it("wraps HTTPS body-read aborts as upstream errors", async () => {
    const timeoutCtrl = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutCtrl.signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected fetch signal");
      return new Response(abortableStream(signal), {
        headers: { "content-type": "image/png" },
      });
    });

    const ctx = createExecutionContext();
    const pending = fetchImageBytes(
      testEnv,
      "https://example.com/slow-buffered-timeout.png",
      ctx,
    );
    timeoutCtrl.abort(new DOMException("timed out", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({
      status: 502,
      code: "upstream_error",
      message: expect.stringContaining("image fetch failed"),
    });
  });

  it("wraps IPFS body-read aborts as upstream errors", async () => {
    const timeoutCtrl = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutCtrl.signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected fetch signal");
      return new Response(abortableStream(signal), {
        headers: { "content-type": "image/png" },
      });
    });

    const ctx = createExecutionContext();
    const pending = fetchImageBytes(
      testEnv,
      `ipfs://${VALID_CID}/slow-buffered-timeout.png`,
      ctx,
    );
    timeoutCtrl.abort(new DOMException("timed out", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({
      status: 502,
      code: "upstream_error",
      message: expect.stringContaining("image fetch failed"),
    });
  });
});

describe("fetchImageBytes without content-length", () => {
  it("reads under-limit HTTPS images without calling arrayBuffer()", async () => {
    const calls = { count: 0 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      trackArrayBufferCalls(
        new Response(chunkStream([PNG_BYTES]), {
          headers: { "content-type": "image/png", etag: '"https-under-limit"' },
        }),
        calls,
      )
    );

    const ctx = createExecutionContext();
    const image = await fetchImageBytes(
      testEnv,
      "https://example.com/no-length-under-limit.png",
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(calls.count).toBe(0);
    expect(image.contentType).toBe("image/png");
    expect(image.etag).toBe('"https-under-limit"');
    expect(image.body).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(image.body as ArrayBuffer)).toEqual(PNG_BYTES);
  });

  it("reads under-limit IPFS images without calling arrayBuffer()", async () => {
    const calls = { count: 0 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      trackArrayBufferCalls(
        new Response(chunkStream([PNG_BYTES]), {
          headers: { "content-type": "image/png" },
        }),
        calls,
      )
    );

    const ctx = createExecutionContext();
    const image = await fetchImageBytes(
      testEnv,
      `ipfs://${VALID_CID}/no-length-under-limit.png`,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(calls.count).toBe(0);
    expect(image.contentType).toBe("image/png");
    expect(image.etag).toBe(`"ipfs:${VALID_CID}/no-length-under-limit.png"`);
    expect(image.body).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(image.body as ArrayBuffer)).toEqual(PNG_BYTES);
  });

  it("resolves IPFS images with a case-insensitive scheme prefix", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(chunkStream([PNG_BYTES]), {
        headers: { "content-type": "image/png" },
      }),
    );

    const ctx = createExecutionContext();
    const image = await fetchImageBytes(
      testEnv,
      `IPFS://${VALID_CID}/uppercase-prefix.png`,
      ctx,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://gateway.example/ipfs/${VALID_CID}/uppercase-prefix.png`,
    );
    expect(image.contentType).toBe("image/png");
  });

  it("resolves IPNS images through the configured gateway", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(chunkStream([PNG_BYTES]), {
        headers: { "content-type": "image/png" },
      }),
    );

    const ctx = createExecutionContext();
    const image = await fetchImageBytes(
      testEnv,
      "ipns://metadata.example/avatar.png",
      ctx,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://gateway.example/ipns/metadata.example/avatar.png",
    );
    expect(image.contentType).toBe("image/png");
    expect(new Uint8Array(image.body as ArrayBuffer)).toEqual(PNG_BYTES);
  });

  it("resolves arweave images through arweave.net", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(chunkStream([PNG_BYTES]), {
        headers: { "content-type": "image/png" },
      }),
    );

    const ctx = createExecutionContext();
    const image = await fetchImageBytes(testEnv, "ar://abcDEF123/avatar.png", ctx);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://arweave.net/abcDEF123/avatar.png",
    );
    expect(image.contentType).toBe("image/png");
    expect(new Uint8Array(image.body as ArrayBuffer)).toEqual(PNG_BYTES);
  });

  it("rejects oversize HTTPS images and cancels the reader before EOF", async () => {
    const calls = { count: 0 };
    const body = overflowStream();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      trackArrayBufferCalls(
        new Response(body.stream, {
          headers: { "content-type": "image/png" },
        }),
        calls,
      )
    );

    const ctx = createExecutionContext();
    await expect(
      fetchImageBytes(
        testEnv,
        "https://example.com/no-length-over-limit.png",
        ctx,
      ),
    ).rejects.toThrowError(/image exceeds size limit/);

    expect(calls.count).toBe(0);
    expect(body.pullCount()).toBeLessThan(4);
    expect(body.reachedEof()).toBe(false);
    expect(body.wasCanceled()).toBe(true);
  });

  it("rejects oversize IPFS images and cancels the reader before EOF", async () => {
    const calls = { count: 0 };
    const body = overflowStream();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      trackArrayBufferCalls(
        new Response(body.stream, {
          headers: { "content-type": "image/png" },
        }),
        calls,
      )
    );

    const ctx = createExecutionContext();
    await expect(
      fetchImageBytes(
        testEnv,
        `ipfs://${VALID_CID}/no-length-over-limit.png`,
        ctx,
      ),
    ).rejects.toThrowError(/image exceeds size limit/);

    expect(calls.count).toBe(0);
    expect(body.pullCount()).toBeLessThan(4);
    expect(body.reachedEof()).toBe(false);
    expect(body.wasCanceled()).toBe(true);
  });

  it("sniffs and sanitizes SVG bodies when content-type is missing", async () => {
    const calls = { count: 0 };
    const dirtySvg =
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>';
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      trackArrayBufferCalls(
        new Response(chunkStream([new TextEncoder().encode(dirtySvg)])),
        calls,
      )
    );

    const ctx = createExecutionContext();
    const image = await fetchImageBytes(
      testEnv,
      "https://example.com/no-type.svg",
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(calls.count).toBe(0);
    expect(image.contentType).toBe(SVG_MIME);
    expect(image.body).toBeInstanceOf(ArrayBuffer);
    const clean = new TextDecoder().decode(image.body as ArrayBuffer);
    expect(clean).toContain("<svg");
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toContain("alert(1)");
  });
});
