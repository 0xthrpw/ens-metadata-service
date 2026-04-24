import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "../../src/services/sanitize";

describe("sanitizeSvg", () => {
  it("preserves benign SVG markup", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="3"/></svg>';
    const clean = await sanitizeSvg(svg);
    expect(clean).toContain("<svg");
    expect(clean).toContain("<circle");
  });

  it("strips <script> elements", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>';
    const clean = await sanitizeSvg(svg);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toContain("alert(1)");
  });

  it("strips inline event handlers", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)" width="10" height="10"/></svg>';
    const clean = await sanitizeSvg(svg);
    expect(clean).not.toMatch(/onclick/i);
    expect(clean).not.toContain("alert(1)");
  });

  it("strips javascript: URLs on anchors", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>';
    const clean = await sanitizeSvg(svg);
    expect(clean).not.toContain("javascript:");
  });
});
