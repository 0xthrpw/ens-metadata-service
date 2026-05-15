import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const BASE = "http://example.com";

function completionLines(spy: ReturnType<typeof vi.spyOn>): any[] {
  return (spy.mock.calls as unknown[][])
    .map((c) => {
      try {
        return JSON.parse(c[0] as string);
      } catch {
        return null;
      }
    })
    .filter((p): p is Record<string, unknown> => !!p && p.event === "request_complete");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request correlation middleware", () => {
  it("emits one request_complete line with method/path/status/duration/reqId", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await SELF.fetch(`${BASE}/favicon.ico`);
    expect(res.status).toBe(204);

    const line = completionLines(spy).at(-1);
    expect(line).toBeTruthy();
    expect(line.method).toBe("GET");
    expect(line.path).toBe("/favicon.ico");
    expect(line.status).toBe(204);
    expect(typeof line.durationMs).toBe("number");
    expect(typeof line.reqId).toBe("string");
    expect(line.reqId.length).toBeGreaterThan(0);
  });

  it("uses the inbound cf-ray as the request id", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await SELF.fetch(`${BASE}/favicon.ico`, {
      headers: { "cf-ray": "test-ray-abc123" },
    });
    expect(completionLines(spy).at(-1)?.reqId).toBe("test-ray-abc123");
  });

  it("falls back to a distinct UUID when cf-ray is absent", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await SELF.fetch(`${BASE}/favicon.ico`);
    await SELF.fetch(`${BASE}/favicon.ico`);
    const lines = completionLines(spy);
    const a = lines.at(-2)?.reqId as string;
    const b = lines.at(-1)?.reqId as string;
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("surfaces network/name path params on a 4xx, and still logs completion", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await SELF.fetch(`${BASE}/fakenet/avatar/vitalik.eth`);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const line = completionLines(spy).at(-1);
    expect(line.network).toBe("fakenet");
    expect(line.name).toBe("vitalik.eth");
    expect(line.status).toBe(res.status);
  });
});
