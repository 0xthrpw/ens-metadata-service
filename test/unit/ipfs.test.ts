import { describe, expect, it } from "vitest";
import { parseIpfs } from "../../src/services/ipfs";

describe("parseIpfs", () => {
  it("parses a v0 CID with ipfs:// prefix", () => {
    const r = parseIpfs("ipfs://QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A");
    expect(r).toEqual({
      cid: "QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A",
      path: "",
    });
  });

  it("parses a v0 CID with subpath", () => {
    const r = parseIpfs(
      "ipfs://QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A/avatar.png",
    );
    expect(r?.cid).toBe("QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A");
    expect(r?.path).toBe("/avatar.png");
  });

  it("parses a bare CID", () => {
    const r = parseIpfs("QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A");
    expect(r?.cid).toBe("QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A");
  });

  it("parses a v1 CID", () => {
    const r = parseIpfs("ipfs://bafybeicg2rbjd6ts7s5jxk4a6wn7l3t3vg7d3pxkpnq6xwefj6o76hmwsu");
    expect(r?.cid.startsWith("bafy")).toBe(true);
  });

  it("rejects non-ipfs URIs", () => {
    expect(parseIpfs("https://example.com/foo")).toBeNull();
    expect(parseIpfs("data:image/png;base64,AAAA")).toBeNull();
    expect(parseIpfs("")).toBeNull();
  });
});
