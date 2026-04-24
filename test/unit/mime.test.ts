import { describe, expect, it } from "vitest";
import { isSvgMime, sniffMime, SVG_MIME } from "../../src/lib/mime";

describe("isSvgMime", () => {
  it("matches common svg content-types", () => {
    expect(isSvgMime("image/svg+xml")).toBe(true);
    expect(isSvgMime("IMAGE/SVG+XML; charset=utf-8")).toBe(true);
  });

  it("rejects non-svg", () => {
    expect(isSvgMime("image/png")).toBe(false);
    expect(isSvgMime(null)).toBe(false);
    expect(isSvgMime(undefined)).toBe(false);
    expect(isSvgMime("")).toBe(false);
  });
});

describe("sniffMime", () => {
  it("detects PNG magic", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffMime(png)).toBe("image/png");
  });

  it("detects JPEG magic", () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(sniffMime(jpg)).toBe("image/jpeg");
  });

  it("detects GIF magic", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(sniffMime(gif)).toBe("image/gif");
  });

  it("detects WEBP magic", () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(sniffMime(webp)).toBe("image/webp");
  });

  it("detects SVG via text sniff", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(sniffMime(svg)).toBe(SVG_MIME);
  });

  it("falls back for unknown bytes", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    expect(sniffMime(bytes)).toBe("application/octet-stream");
    expect(sniffMime(bytes, "custom/x")).toBe("custom/x");
  });
});
