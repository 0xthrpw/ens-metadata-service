import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import SatoshiBold from "../fonts/Satoshi-Bold.ttf";
import { inlineEmojiAsImages } from "./emojiInline";
import { extractRenderedText, loadFallbackFontBuffers } from "./fontLoader";

// initWasm rejects on a second call within the same isolate, so cache the
// promise — every subsequent rasterize awaits the same init.
let wasmReady: Promise<void> | null = null;

function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm(resvgWasm);
  }
  return wasmReady;
}

const SATOSHI_FONT = new Uint8Array(SatoshiBold);

export async function rasterizeNameImageSvg(svg: string): Promise<Uint8Array> {
  // Inline color emoji as <image> elements before rasterization. resvg-wasm
  // 2.6.2 doesn't paint COLR glyphs, so any emoji in the source SVG would
  // render blank. The /image (SVG) endpoint never goes through this path.
  const preparedSvg = await inlineEmojiAsImages(svg);
  // Kick off wasm init and font fetches in parallel — both are async and
  // independent of each other.
  const fallbackText = extractRenderedText(preparedSvg);
  const [, fallbackFonts] = await Promise.all([
    ensureWasm(),
    loadFallbackFontBuffers(fallbackText),
  ]);
  const resvg = new Resvg(preparedSvg, {
    font: {
      fontBuffers: [SATOSHI_FONT, ...fallbackFonts],
      defaultFontFamily: "Satoshi",
    },
    fitTo: { mode: "original" },
    textRendering: 1,
    shapeRendering: 2,
  });
  const rendered = resvg.render();
  try {
    return rendered.asPng();
  } finally {
    rendered.free();
    resvg.free();
  }
}
