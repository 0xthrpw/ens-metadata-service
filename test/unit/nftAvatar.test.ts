import { describe, expect, it } from "vitest";
import { expandIdTemplate, extractImageUri } from "../../src/services/nftAvatar";
import { classifyUri } from "../../src/services/avatarResolver";

describe("expandIdTemplate", () => {
	it("replaces {id} with 64-char zero-padded lowercase hex", () => {
		expect(expandIdTemplate("https://api.example.com/{id}.json", "1")).toBe(
			"https://api.example.com/0000000000000000000000000000000000000000000000000000000000000001.json",
		);
		expect(expandIdTemplate("ipfs://CID/{id}", "1719")).toBe(
			"ipfs://CID/00000000000000000000000000000000000000000000000000000000000006b7",
		);
	});

	it("handles large token IDs (uint256)", () => {
		const big = "115792089237316195423570985008687907853269984665640564039457584007913129639935"; // 2^256-1
		expect(expandIdTemplate("ipfs://x/{id}", big)).toBe(
			"ipfs://x/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		);
	});

	it("is a no-op when template lacks {id}", () => {
		expect(expandIdTemplate("https://api.example.com/token/123", "1")).toBe(
			"https://api.example.com/token/123",
		);
	});

	it("replaces every occurrence of {id}", () => {
		expect(expandIdTemplate("{id}/{id}", "5")).toBe(
			"0000000000000000000000000000000000000000000000000000000000000005/0000000000000000000000000000000000000000000000000000000000000005",
		);
	});
});

describe("extractImageUri", () => {
	it("returns the `image` field when present", () => {
		expect(extractImageUri({ image: "ipfs://abc" })).toBe("ipfs://abc");
	});

	it("falls back to `image_url` (OpenSea variant)", () => {
		expect(extractImageUri({ image_url: "https://example.com/x.png" })).toBe(
			"https://example.com/x.png",
		);
	});

	it("wraps `image_data` SVG markup in a base64 data URI", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
		const out = extractImageUri({ image_data: svg });
		expect(out).toMatch(/^data:image\/svg\+xml;base64,/);
		// Decode and verify roundtrip
		const base64 = out!.replace(/^data:image\/svg\+xml;base64,/, "");
		expect(atob(base64)).toBe(svg);
	});

	it("prefers `image` over `image_url` and `image_data`", () => {
		expect(
			extractImageUri({
				image: "ipfs://primary",
				image_url: "https://secondary",
				image_data: "<svg/>",
			}),
		).toBe("ipfs://primary");
	});

	it("returns null for missing/empty/non-object inputs", () => {
		expect(extractImageUri(null)).toBeNull();
		expect(extractImageUri(undefined)).toBeNull();
		expect(extractImageUri("not-an-object")).toBeNull();
		expect(extractImageUri({})).toBeNull();
		expect(extractImageUri({ image: "" })).toBeNull();
	});
});

describe("classifyUri ar:// handling", () => {
	it("rewrites ar://TXID to https://arweave.net/TXID", () => {
		const out = classifyUri("ar://abcDEF123");
		expect(out).toEqual({ kind: "https", url: "https://arweave.net/abcDEF123" });
	});

	it("preserves the path component after the txid", () => {
		const out = classifyUri("ar://abc/path/to/file.json");
		expect(out).toEqual({ kind: "https", url: "https://arweave.net/abc/path/to/file.json" });
	});

	it("rejects empty ar:// URIs", () => {
		expect(() => classifyUri("ar://")).toThrow();
	});
});

describe("classifyUri eip155 namespace", () => {
	it("preserves the erc721 / erc1155 namespace in the parsed result", () => {
		const erc721 = classifyUri(
			"eip155:1/erc721:0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6/1719",
		);
		expect(erc721).toMatchObject({
			kind: "eip155",
			chainId: 1,
			namespace: "erc721",
			contract: "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6",
			tokenId: "1719",
		});

		const erc1155 = classifyUri(
			"eip155:8453/erc1155:0xD4307E0acD12CF46fD6cf93BC264f5D5D1598792/1",
		);
		expect(erc1155).toMatchObject({
			kind: "eip155",
			chainId: 8453,
			namespace: "erc1155",
			tokenId: "1",
		});
	});
});
