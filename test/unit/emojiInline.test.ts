import { describe, expect, it } from "vitest";
import { emojiFilename, inlineEmojiAsImages, isEmojiGrapheme } from "../../src/services/emojiInline";

describe("emojiFilename", () => {
	it("encodes a single-codepoint emoji", () => {
		expect(emojiFilename("🔥")).toBe("1f525");
		expect(emojiFilename("🌍")).toBe("1f30d");
	});

	it("strips Variation Selector-16 (U+FE0F)", () => {
		// "1️⃣" is U+0031 U+FE0F U+20E3 — Twemoji file is "31-20e3.svg".
		expect(emojiFilename("1️⃣")).toBe("31-20e3");
		// "☀️" is U+2600 U+FE0F — Twemoji file is "2600.svg".
		expect(emojiFilename("☀️")).toBe("2600");
	});

	it("preserves ZWJ sequences", () => {
		// 👨‍👩‍👧 = U+1F468 U+200D U+1F469 U+200D U+1F467
		expect(emojiFilename("\u{1F468}‍\u{1F469}‍\u{1F467}")).toBe(
			"1f468-200d-1f469-200d-1f467",
		);
	});

	it("strips FE0F from ZWJ sequences too (matches @twemoji/svg asset names)", () => {
		// 👁️‍🗨️ = U+1F441 U+FE0F U+200D U+1F5E8 U+FE0F → "1f441-200d-1f5e8"
		expect(emojiFilename("\u{1F441}️‍\u{1F5E8}️")).toBe(
			"1f441-200d-1f5e8",
		);
	});
});

describe("isEmojiGrapheme", () => {
	it("detects emoji codepoints", () => {
		expect(isEmojiGrapheme("🔥")).toBe(true);
		expect(isEmojiGrapheme("🌍")).toBe(true);
		expect(isEmojiGrapheme("☀️")).toBe(true);
	});

	it("returns false for ASCII and non-emoji scripts", () => {
		expect(isEmojiGrapheme("a")).toBe(false);
		expect(isEmojiGrapheme(".")).toBe(false);
		expect(isEmojiGrapheme("中")).toBe(false);
		expect(isEmojiGrapheme("ع")).toBe(false);
	});
});

describe("inlineEmojiAsImages", () => {
	it("leaves emoji-free SVG untouched", async () => {
		const svg = '<svg><text x="10" y="50" font-size="20px" fill="white">vitalik.eth</text></svg>';
		const out = await inlineEmojiAsImages(svg);
		expect(out).toBe(svg);
	});

	it("rewrites emoji-bearing text into image + text runs", async () => {
		// Stub fetch so the test doesn't hit the network.
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } })) as typeof fetch;
		try {
			const svg = '<svg><text x="10" y="50" font-size="20px" fill="white">🔥.eth</text></svg>';
			const out = await inlineEmojiAsImages(svg);
			expect(out).toContain("<image");
			expect(out).toContain("data:image/svg+xml;base64,");
			expect(out).toContain(">.eth<");
			expect(out).not.toContain(">🔥.eth<");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
