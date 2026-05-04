import { describe, expect, it } from "vitest";
import { getFontSize } from "../../src/services/nameImage";

const TOLERANCE = 1;

const UPSTREAM_FONT_SIZE_CASES = [
	["sep.eth", 32],
	["nick.eth", 32],
	["jeff.eth", 32],
	["pepe.eth", 32],
	["token.eth", 32],
	["defi.eth", 32],

	["vitalik.eth", 32],
	["brantly.eth", 32],
	["ethereum.eth", 32],
	["coinbase.eth", 32],
	["bitcoin.eth", 32],
	["uniswap.eth", 32],
	["foundation.eth", 29],
	["blockchain.eth", 29],

	["cryptopunks.eth", 26],
	["decentraland.eth", 25],
	["smartcontract.eth", 24],
	["cryptocurrency.eth", 22],
	["satoshinakamoto.eth", 20],
	["ethereumfoundation.eth", 17],

	["123.eth", 32],
	["1990.eth", 29],
	["2024.eth", 29],
	["999999.eth", 21],
	["1234567890.eth", 14],
	["1234567890123.eth", 11],

	["web3.eth", 32],
	["l33t.eth", 32],
	["eth2.eth", 32],

	["👨‍👩‍👧.eth", 32],
	["👨‍💻.eth", 32],
	["💎🙌🚀.eth", 32],
	["🔥🔥🔥.eth", 32],
	["💰💰💰.eth", 32],

	["fire🔥.eth", 32],

	["привет.eth", 32],

	["数字化货币.eth", 31],
	["数字化生活.eth", 31],
	["虚拟数字人.eth", 31],
	["元宇宙虚拟现实世界.eth", 20],
	["警惕高额回报虚拟货币都是诈骗.eth", 13],
	["草拟妈个逼.eth", 31],
] as const;

describe("getFontSize", () => {
	it.each(UPSTREAM_FONT_SIZE_CASES)(
		"renders %s within %ipx of upstream's %ipx",
		(name, upstream) => {
			const ours = getFontSize(name);
			const delta = Math.abs(ours - upstream);
			expect(
				delta,
				`expected getFontSize(${JSON.stringify(name)}) within ±${TOLERANCE}px of ${upstream}, got ${ours} (delta ${delta})`,
			).toBeLessThanOrEqual(TOLERANCE);
		},
	);

	it("returns 32 for empty input", () => {
		expect(getFontSize("")).toBe(32);
	});

	it("clamps at 32 (no values 33-34)", () => {
		const fits = getFontSize("a.eth");
		expect(fits).toBeLessThanOrEqual(32);
		expect(fits).not.toBe(33);
	});
});

