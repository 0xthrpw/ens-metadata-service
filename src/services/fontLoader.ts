// Per-request font subset loading for resvg-wasm. Mirrors the
// FALLBACK_FONTS map from fix/expand-unicode-font-coverage (Satori-based)
// but yields raw font buffers for resvg's `font.fontBuffers` instead of
// Satori font descriptors. Subsets are fetched from Google Fonts on demand
// and cached at the Cloudflare edge so warm requests pay nothing.

// Modern UA so Google Fonts returns TTF subsets — resvg-wasm 2.6.2 can't
// parse woff (woff2 unverified), and the legacy Safari UA other branches
// use returns the full unsubsetted TTF that drops some codepoints.
const GOOGLE_FONT_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

type FallbackFont = {
	family: string;
	weight: number;
	test: RegExp;
};

const FALLBACK_FONTS: FallbackFont[] = [
	{
		family: "Noto Sans Symbols",
		weight: 700,
		test: /[←-⇿①-⓿]/u,
	},
	{
		family: "Noto Sans Symbols 2",
		weight: 400,
		test: /[∀-⋿⌀-⏿─-➿⬀-⯿]/u,
	},
	{
		// Monochrome outline emoji — fills with text color (white over the
		// gradient), matching the SVG fallback aesthetic. resvg can't render
		// the bitmap CBDT in Noto Color Emoji, and a COLR alternative would
		// blow the bundle. Covers BMP misc symbols + dingbats + the full
		// supplementary emoji planes.
		family: "Noto Emoji",
		weight: 700,
		test: /[\u{2600}-\u{26FF}\u{1F000}-\u{1FFFF}]/u,
	},
	{
		family: "Noto Sans",
		weight: 700,
		test: /[-ɏͰ-ϿЀ-ӿԀ-ԯ԰-֏Ḁ-ỿ -↏]/u,
	},
	{
		family: "Noto Sans NKo",
		weight: 400,
		test: /[߀-߿]/u,
	},
	{
		family: "Noto Sans SC",
		weight: 900,
		test: /[⺀-鿿豈-﫿＀-￯　-〿㐀-䶿]/u,
	},
	{
		family: "Noto Sans JP",
		weight: 900,
		test: /[぀-ゟ゠-ヿㇰ-ㇿ]/u,
	},
	{
		family: "Noto Sans KR",
		weight: 900,
		test: /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힯]/u,
	},
	{
		family: "Noto Sans Ethiopic",
		weight: 700,
		test: /[ሀ-፿ᎀ-᎟ⶀ-⷟]/u,
	},
	{
		family: "Noto Sans Thai",
		weight: 700,
		test: /[฀-๿]/u,
	},
	{
		family: "Noto Sans Hebrew",
		weight: 700,
		test: /[֐-׿יִ-ﭏ]/u,
	},
	{
		family: "Noto Sans Arabic",
		weight: 700,
		test: /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/u,
	},
];

// Extract text content from <text>/<tspan> nodes; ignores element attributes
// and the warning-badge paths. Matches our SVG template — not a general
// SVG parser.
const TEXT_NODE_RE = /<(?:text|tspan)\b[^>]*>([^<]*)<\/(?:text|tspan)>/g;

export function extractRenderedText(svg: string): string {
	let combined = "";
	for (const m of svg.matchAll(TEXT_NODE_RE)) combined += m[1] ?? "";
	return combined;
}

async function fetchWithEdgeCache(url: string, headers?: HeadersInit): Promise<Response> {
	return fetch(url, {
		headers,
		cf: { cacheTtl: 86_400, cacheEverything: true },
	} as RequestInit);
}

async function loadGoogleFontSubset(
	family: string,
	weight: number,
	chars: string,
): Promise<ArrayBuffer | null> {
	if (!chars) return null;
	const unique = [...new Set(chars)].join("");
	const baseUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`;
	// Per-character subset first (small); some Symbols families 400 their
	// `text=` URL, so fall back to the unsubsetted CSS.
	const cssUrls = [`${baseUrl}&text=${encodeURIComponent(unique)}`, baseUrl];
	for (const cssUrl of cssUrls) {
		try {
			const cssRes = await fetchWithEdgeCache(cssUrl, { "User-Agent": GOOGLE_FONT_UA });
			if (!cssRes.ok) continue;
			const css = await cssRes.text();
			const match = css.match(/src:\s*url\((https:\/\/[^)]+)\)/);
			if (!match || !match[1]) continue;
			const fontRes = await fetchWithEdgeCache(match[1]);
			if (!fontRes.ok) continue;
			return await fontRes.arrayBuffer();
		} catch {
			// next URL
		}
	}
	return null;
}

export async function loadFallbackFontBuffers(text: string): Promise<Uint8Array[]> {
	if (!text) return [];
	const buffers = await Promise.all(
		FALLBACK_FONTS.map(async (f) => {
			const chars = Array.from(text)
				.filter((c) => f.test.test(c))
				.join("");
			if (!chars) return null;
			const data = await loadGoogleFontSubset(f.family, f.weight, chars);
			return data ? new Uint8Array(data) : null;
		}),
	);
	return buffers.filter((b) => b !== null) as Uint8Array[];
}
