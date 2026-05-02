import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../../src/env";
import { fetchImageBytes } from "../../src/services/image";
import { SANITIZER_VERSION } from "../../src/services/sanitize";
import { putHttps, putIpfs, getHttps, getIpfs } from "../../src/storage/r2Cache";
import type { IpfsRef } from "../../src/services/ipfs";

const testEnv = env as unknown as Env;
const originalIpfsGateways = testEnv.IPFS_GATEWAYS;

const PNG_B64 = "iVBORw0KGgo=";
const PNG_DATA_URI = `data:image/png;base64,${PNG_B64}`;

const FRESH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image href="${PNG_DATA_URI}" xlink:href="${PNG_DATA_URI}"/></svg>`;
const STRIPPED_SVG = `<svg xmlns="http://www.w3.org/2000/svg"><image/></svg>`;

const HTTPS_URL = "https://storage.example.test/header.svg";
const IPFS_REF: IpfsRef = { cid: "QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A", path: "/header.svg" };
const STALE_VERSION = "0";

const encoder = new TextEncoder();

function svgBytes(s: string): ArrayBuffer {
  return encoder.encode(s).buffer as ArrayBuffer;
}

beforeEach(() => {
  testEnv.IPFS_GATEWAYS = "https://ipfs-gateway.example";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  testEnv.IPFS_GATEWAYS = originalIpfsGateways;
});

describe("sanitizer version cache gating", () => {
  describe("HTTPS miss path", () => {
    it("writes sanitizerVersion to R2 after fetching a fresh SVG", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(FRESH_SVG, {
          headers: {
            "content-type": "image/svg+xml",
            "content-length": String(encoder.encode(FRESH_SVG).byteLength),
            etag: '"fresh-etag"',
          },
        }),
      );

      const ctx = createExecutionContext();
      const result = await fetchImageBytes(testEnv, HTTPS_URL, ctx);
      await waitOnExecutionContext(ctx);

      const body = new TextDecoder().decode(result.body as ArrayBuffer);
      expect(body).toContain(PNG_B64);
      expect(result.contentType).toBe("image/svg+xml");

      const cached = await getHttps(testEnv, HTTPS_URL);
      expect(cached).not.toBeNull();
      expect(cached!.sanitizerVersion).toBe(SANITIZER_VERSION);
      expect(cached!.sanitized).toBe(true);
    });

    it("returns a versioned ETag for fresh SVG responses", async () => {
      const sourceEtag = '"source-abc"';
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(FRESH_SVG, {
          headers: {
            "content-type": "image/svg+xml",
            "content-length": String(encoder.encode(FRESH_SVG).byteLength),
            etag: sourceEtag,
          },
        }),
      );

      const ctx = createExecutionContext();
      const result = await fetchImageBytes(testEnv, HTTPS_URL + "?etag-test", ctx);
      await waitOnExecutionContext(ctx);

      expect(result.etag).toBe(`"source-abc-sv${SANITIZER_VERSION}"`);
    });

    it("does not add versioned ETag suffix for non-SVG responses", async () => {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(pngBytes, {
          headers: {
            "content-type": "image/png",
            "content-length": "4",
            etag: '"png-etag"',
          },
        }),
      );

      const ctx = createExecutionContext();
      const result = await fetchImageBytes(testEnv, HTTPS_URL + "?png-test", ctx);
      await waitOnExecutionContext(ctx);

      expect(result.etag).toBe('"png-etag"');
      expect(result.contentType).toBe("image/png");
    });
  });

  describe("HTTPS stale version (force re-fetch)", () => {
    it("re-fetches when cached SVG has a stale sanitizerVersion", async () => {
      await putHttps(
        testEnv,
        HTTPS_URL + "?stale",
        svgBytes(STRIPPED_SVG),
        "image/svg+xml",
        '"stale-etag"',
        undefined,
        true,
        STALE_VERSION,
      );

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(FRESH_SVG, {
          headers: {
            "content-type": "image/svg+xml",
            "content-length": String(encoder.encode(FRESH_SVG).byteLength),
            etag: '"fresh-etag"',
          },
        }),
      );

      const ctx = createExecutionContext();
      const result = await fetchImageBytes(testEnv, HTTPS_URL + "?stale", ctx);
      await waitOnExecutionContext(ctx);

      const body = new TextDecoder().decode(result.body as ArrayBuffer);
      expect(body).toContain(PNG_B64);

      const callArgs = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(callArgs?.headers).not.toMatchObject({ "If-None-Match": expect.any(String) });
      expect(callArgs?.headers).not.toMatchObject({ "If-Modified-Since": expect.any(String) });

      const cached = await getHttps(testEnv, HTTPS_URL + "?stale");
      expect(cached!.sanitizerVersion).toBe(SANITIZER_VERSION);
    });

    it("re-fetches when cached SVG has no sanitizerVersion (legacy entry)", async () => {
      await putHttps(
        testEnv,
        HTTPS_URL + "?legacy",
        svgBytes(STRIPPED_SVG),
        "image/svg+xml",
        '"legacy-etag"',
        undefined,
        true,
        undefined,
      );

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(FRESH_SVG, {
          headers: {
            "content-type": "image/svg+xml",
            "content-length": String(encoder.encode(FRESH_SVG).byteLength),
            etag: '"fresh-etag"',
          },
        }),
      );

      const ctx = createExecutionContext();
      const result = await fetchImageBytes(testEnv, HTTPS_URL + "?legacy", ctx);
      await waitOnExecutionContext(ctx);

      const body = new TextDecoder().decode(result.body as ArrayBuffer);
      expect(body).toContain(PNG_B64);

      const callArgs = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(callArgs?.headers).not.toMatchObject({ "If-None-Match": expect.any(String) });

      const cached = await getHttps(testEnv, HTTPS_URL + "?legacy");
      expect(cached!.sanitizerVersion).toBe(SANITIZER_VERSION);
    });
  });

  describe("HTTPS 304 path with current sanitizer version", () => {
    it("serves cached bytes with versioned ETag on 304", async () => {
      await putHttps(
        testEnv,
        HTTPS_URL + "?current",
        svgBytes(FRESH_SVG),
        "image/svg+xml",
        '"current-etag"',
        undefined,
        true,
        SANITIZER_VERSION,
      );

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(null, { status: 304 }),
      );

      const ctx = createExecutionContext();
      const result = await fetchImageBytes(testEnv, HTTPS_URL + "?current", ctx);
      await waitOnExecutionContext(ctx);

      const body = new TextDecoder().decode(result.body as ArrayBuffer);
      expect(body).toContain(PNG_B64);
      expect(result.etag).toBe(`"current-etag-sv${SANITIZER_VERSION}"`);
    });
  });

  describe("IPFS stale version re-sanitization", () => {
    it("re-sanitizes stale IPFS SVG cache hit and writes back with current version", async () => {
      await putIpfs(
        testEnv,
        IPFS_REF,
        svgBytes(STRIPPED_SVG),
        "image/svg+xml",
        true,
        STALE_VERSION,
      );

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(FRESH_SVG, {
          headers: { "content-type": "image/svg+xml" },
        }),
      );

      const ctx = createExecutionContext();
      const result = await fetchImageBytes(
        testEnv,
        `ipfs://${IPFS_REF.cid}${IPFS_REF.path}`,
        ctx,
      );
      await waitOnExecutionContext(ctx);

      const body = new TextDecoder().decode(result.body as ArrayBuffer);
      expect(body).toContain(PNG_B64);

      const cached = await getIpfs(testEnv, IPFS_REF);
      expect(cached!.sanitizerVersion).toBe(SANITIZER_VERSION);
      expect(cached!.sanitized).toBe(true);
    });

    it("re-sanitizes IPFS SVG with no sanitizerVersion (legacy entry) and writes back", async () => {
      const legacyRef: IpfsRef = { cid: "QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A", path: "/legacy.svg" };

      await putIpfs(
        testEnv,
        legacyRef,
        svgBytes(STRIPPED_SVG),
        "image/svg+xml",
        true,
        undefined,
      );

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(FRESH_SVG, {
          headers: { "content-type": "image/svg+xml" },
        }),
      );

      const ctx = createExecutionContext();
      const result = await fetchImageBytes(
        testEnv,
        `ipfs://${legacyRef.cid}${legacyRef.path}`,
        ctx,
      );
      await waitOnExecutionContext(ctx);

      const body = new TextDecoder().decode(result.body as ArrayBuffer);
      expect(body).toContain(PNG_B64);

      const cached = await getIpfs(testEnv, legacyRef);
      expect(cached!.sanitizerVersion).toBe(SANITIZER_VERSION);
    });

    it("serves cached IPFS SVG without re-fetching when version is current", async () => {
      const currentRef: IpfsRef = { cid: "QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A", path: "/current.svg" };

      await putIpfs(
        testEnv,
        currentRef,
        svgBytes(FRESH_SVG),
        "image/svg+xml",
        true,
        SANITIZER_VERSION,
      );

      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const ctx = createExecutionContext();
      const result = await fetchImageBytes(
        testEnv,
        `ipfs://${currentRef.cid}${currentRef.path}`,
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(fetchSpy).not.toHaveBeenCalled();
      const body = new TextDecoder().decode(result.body as ArrayBuffer);
      expect(body).toContain(PNG_B64);
    });
  });

  describe("ETag versioning", () => {
    it("ETag for sanitized SVG includes -sv suffix with SANITIZER_VERSION", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(FRESH_SVG, {
          headers: {
            "content-type": "image/svg+xml",
            "content-length": String(encoder.encode(FRESH_SVG).byteLength),
            etag: '"abc123"',
          },
        }),
      );

      const ctx = createExecutionContext();
      const result = await fetchImageBytes(testEnv, HTTPS_URL + "?etag-check", ctx);
      await waitOnExecutionContext(ctx);

      expect(result.etag).toBe(`"abc123-sv${SANITIZER_VERSION}"`);
      expect(result.etag).toContain(`-sv`);
      expect(result.etag).toContain(SANITIZER_VERSION);
    });

    it("data URI preservation: sanitized HTTPS SVG body contains original PNG data URI", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(FRESH_SVG, {
          headers: {
            "content-type": "image/svg+xml",
            "content-length": String(encoder.encode(FRESH_SVG).byteLength),
          },
        }),
      );

      const ctx = createExecutionContext();
      const result = await fetchImageBytes(testEnv, HTTPS_URL + "?snapshot", ctx);
      await waitOnExecutionContext(ctx);

      const body = new TextDecoder().decode(result.body as ArrayBuffer);
      expect(body).toContain(PNG_DATA_URI);
    });
  });
});
