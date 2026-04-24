// Emoji-as-image substitution for the rasterization path. resvg-wasm 2.6.2
// matches COLR/CPAL fonts (Twemoji, Noto Color Emoji COLRv1) but renders
// zero pixels for color glyphs, so we sidestep font-based emoji entirely:
// each emoji grapheme in the SVG is rewritten as an <image> element pointing
// at the corresponding Twemoji SVG asset on jsdelivr. Edge-cached, so warm
// requests pay nothing.
//
// Only invoked from rasterize.ts (the PNG path). The /image (SVG) endpoint
// receives the original <text> with the literal emoji codepoints — browsers
// render those with their system emoji font.

const TWEMOJI_CDN = "https://cdn.jsdelivr.net/npm/@twemoji/svg";

// Twemoji asset filename: hex codepoints joined with "-", with U+FE0F
// (Variation Selector-16) always stripped. Matches the actual filenames in
// the @twemoji/svg npm package — the older Twemoji JS lib kept FE0F for ZWJ
// sequences but the asset filenames have never carried it (verified against
// the CDN: e.g. `31-20e3.svg` for the keycap "1️⃣", `1f441-200d-1f5e8.svg`
// for the eye-in-speech-bubble ZWJ sequence).
export function emojiFilename(grapheme: string): string {
	const codepoints: string[] = [];
	for (const ch of grapheme) {
		const cp = ch.codePointAt(0);
		if (cp !== undefined && cp !== 0xfe0f) codepoints.push(cp.toString(16));
	}
	return codepoints.join("-");
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;
export function isEmojiGrapheme(grapheme: string): boolean {
	return EMOJI_RE.test(grapheme);
}

async function fetchTwemojiSvg(filename: string): Promise<string | null> {
	try {
		const res = await fetch(`${TWEMOJI_CDN}/${filename}.svg`, {
			cf: { cacheTtl: 86_400, cacheEverything: true },
		} as RequestInit);
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	}
}

// Twemoji SVGs are pure ASCII, so btoa is safe.
function svgToDataUrl(svg: string): string {
	return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Mirrors `estimateAdvance` in nameImage.ts — keep in sync. Returns advance
// width in px at 20px font-size; caller scales by fontSize/20.
function advanceAt20px(grapheme: string): number {
	const cp = grapheme.codePointAt(0) ?? 0;
	if (cp < 0x0300 && grapheme.length === 1) return 14;
	if (cp >= 0x1f000) return 20;
	if (
		(cp >= 0x3000 && cp <= 0x9fff) ||
		(cp >= 0xac00 && cp <= 0xd7af) ||
		(cp >= 0xf900 && cp <= 0xfaff)
	) {
		return 17;
	}
	return 18;
}

function escapeXmlText(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type TextAttrs = {
	x: number;
	y: number;
	fontSize: number;
	rest: string; // verbatim attributes minus x/y/font-size, applied to each emitted <text>
};

function parseTextAttrs(attrStr: string): TextAttrs | null {
	const x = attrStr.match(/\bx="([^"]+)"/);
	const y = attrStr.match(/\by="([^"]+)"/);
	const fs = attrStr.match(/\bfont-size="([\d.]+)(?:px)?"/);
	if (!x || !y || !fs) return null;
	const xNum = Number.parseFloat(x[1]!);
	const yNum = Number.parseFloat(y[1]!);
	const fsNum = Number.parseFloat(fs[1]!);
	if (!Number.isFinite(xNum) || !Number.isFinite(yNum) || !Number.isFinite(fsNum)) return null;
	const rest = attrStr
		.replace(/\bx="[^"]*"/, "")
		.replace(/\by="[^"]*"/, "")
		.replace(/\bfont-size="[^"]*"/, "")
		.replace(/\s+/g, " ")
		.trim();
	return { x: xNum, y: yNum, fontSize: fsNum, rest };
}

async function buildEmojiTextRuns(content: string, attrs: TextAttrs): Promise<string> {
	const segmenter = new Intl.Segmenter();
	const segments = [...segmenter.segment(content)].map((s) => s.segment);
	const advanceScale = attrs.fontSize / 20;
	const parts: string[] = [];
	let textBuffer = "";
	let textStartX = attrs.x;
	let cursorX = attrs.x;

	const flushText = () => {
		if (!textBuffer) return;
		parts.push(
			`<text x="${textStartX.toFixed(2)}" y="${attrs.y}" font-size="${attrs.fontSize}px" ${attrs.rest}>${escapeXmlText(textBuffer)}</text>`,
		);
		textBuffer = "";
	};

	for (const seg of segments) {
		const segWidth = advanceAt20px(seg) * advanceScale;
		if (isEmojiGrapheme(seg)) {
			flushText();
			const filename = emojiFilename(seg);
			const svg = await fetchTwemojiSvg(filename);
			if (svg) {
				const dataUrl = svgToDataUrl(svg);
				// Image bottom aligns with text baseline; image height equals fontSize.
				const imgY = attrs.y - attrs.fontSize;
				parts.push(
					`<image href="${dataUrl}" x="${cursorX.toFixed(2)}" y="${imgY.toFixed(2)}" width="${attrs.fontSize}" height="${attrs.fontSize}"/>`,
				);
			} else {
				// CDN miss — fall back to the literal codepoint so resvg at least
				// emits whatever it can (likely tofu).
				textBuffer = seg;
				textStartX = cursorX;
				flushText();
			}
			cursorX += segWidth;
			textStartX = cursorX;
		} else {
			textBuffer += seg;
			cursorX += segWidth;
		}
	}
	flushText();
	return parts.join("");
}

// Match a <text>…</text> whose content has no nested elements (no '<'). Our
// template only nests <tspan> for very long names (segLen > 25); those don't
// occur with emoji-only inputs in practice, so we skip substitution there and
// fall back to resvg's default (blank/tofu) for those edge cases.
const SIMPLE_TEXT_RE = /<text\s+([^>]*)>([^<]*)<\/text>/g;

export async function inlineEmojiAsImages(svg: string): Promise<string> {
	const matches = [...svg.matchAll(SIMPLE_TEXT_RE)];
	if (matches.length === 0) return svg;

	// Pre-check: only do work for texts that actually contain emoji.
	const work = matches
		.map((m) => ({ match: m, hasEmoji: EMOJI_RE.test(m[2] ?? "") }))
		.filter((w) => w.hasEmoji);
	if (work.length === 0) return svg;

	const replacements = await Promise.all(
		work.map(async ({ match }) => {
			const attrStr = match[1] ?? "";
			const content = match[2] ?? "";
			const attrs = parseTextAttrs(attrStr);
			if (!attrs) return null;
			const replacement = await buildEmojiTextRuns(content, attrs);
			return { full: match[0], replacement };
		}),
	);

	let out = svg;
	for (const r of replacements) {
		if (r) out = out.replace(r.full, r.replacement);
	}
	return out;
}
