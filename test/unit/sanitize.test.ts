import { describe, expect, it } from "vitest";
import { sanitizeSvg, sanitizeSvgStream } from "../../src/services/sanitize";

const encoder = new TextEncoder();

async function sanitizeSvgViaStream(svg: string): Promise<string> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(svg));
      controller.close();
    },
  });

  return new Response(sanitizeSvgStream(input)).text();
}

const SANITIZERS = [
  ["string", sanitizeSvg],
  ["stream", sanitizeSvgViaStream],
] as const;

for (const [mode, sanitize] of SANITIZERS) {
  describe(`sanitizeSvg (${mode})`, () => {
    it("preserves benign SVG markup", async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="3"/></svg>';
      const clean = await sanitize(svg);
      expect(clean).toContain("<svg");
      expect(clean).toContain("<circle");
    });

    it("strips dangerous elements", async () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><rect/></svg>';
      const clean = await sanitize(svg);
      expect(clean).not.toMatch(/<script/i);
      expect(clean).not.toMatch(/foreignObject/i);
      expect(clean).not.toContain("alert(1)");
      expect(clean).not.toContain("bad");
    });

    it("strips inline event handlers", async () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)" onload="alert(2)" width="10" height="10"/></svg>';
      const clean = await sanitize(svg);
      expect(clean).not.toMatch(/onclick/i);
      expect(clean).not.toMatch(/onload/i);
      expect(clean).not.toContain("alert(1)");
      expect(clean).not.toContain("alert(2)");
    });

    it.each([
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "&#74;avascript:alert(1)",
      "&#x4A;avascript:alert(1)",
      "jav&#97;script:alert(1)",
      "jav&#x61;script:alert(1)",
      "java\nscript:alert(1)",
      "java\rscript:alert(1)",
      "java\tscript:alert(1)",
      "javascript&colon;alert(1)",
      "java&newline;script:alert(1)",
      "java&tab;script:alert(1)",
      "vbscript:msgbox(1)",
      "vb&#x09;script:msgbox(1)",
      "data:text/html,<svg/>",
      "d&#97;ta:text/html,<svg/>",
      "file:///etc/passwd",
      "fi&#108;e:///etc/passwd",
    ])("strips dangerous URL values (%s)", async (href) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><a href="${href}"><rect/></a><image src="${href}"/></svg>`;
      const clean = await sanitize(svg);
      expect(clean).not.toMatch(/\s(?:href|src)=/i);
    });

    it.each([
      "https://example.com/avatar.svg",
      "ipfs://bafybeigdyrzt/avatar.svg",
      "/images/avatar.svg",
      "#avatar",
    ])("preserves benign URL values (%s)", async (href) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><a href="${href}"><rect/></a></svg>`;
      const clean = await sanitize(svg);
      expect(clean).toContain(`href="${href}"`);
    });

    it("preserves base64 raster data images embedded in image tags", async () => {
      const href = "data:image/png;base64,iVBORw0KGgo=";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${href}" src="${href}"/></svg>`;
      const clean = await sanitize(svg);
      expect(clean).toContain(`href="${href}"`);
      expect(clean).toContain(`src="${href}"`);
    });

    it("strips data images outside image tags", async () => {
      const href = "data:image/png;base64,iVBORw0KGgo=";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><a href="${href}"><rect/></a></svg>`;
      const clean = await sanitize(svg);
      expect(clean).not.toMatch(/\shref=/i);
    });

    it("preserves xlink:href raster data images embedded in image tags", async () => {
      const href = "data:image/png;base64,iVBORw0KGgo=";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="${href}"/></svg>`;
      const clean = await sanitize(svg);
      expect(clean).toContain(href);
    });

    it("strips data:image/svg+xml even on image tags", async () => {
      const href = "data:image/svg+xml;base64,PHN2Zy8+";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${href}"/></svg>`;
      const clean = await sanitize(svg);
      expect(clean).not.toMatch(/href=/i);
    });
  });
}
