// Bundles the Node entrypoint. The loader map reproduces the wrangler.toml
// [[rules]] the worker build relies on: Data (ttf) -> binary, Text (svg) ->
// text, CompiledWasm (wasm) -> binary bytes (initWasm accepts a BufferSource,
// so raw bytes work where workerd hands over a WebAssembly.Module).
// html-rewriter-wasm stays external: it locates its .wasm sibling on disk at
// require time, which inlining would break.
import { build } from "esbuild";

await build({
  entryPoints: ["src/node/server.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  loader: {
    ".wasm": "binary",
    ".ttf": "binary",
    ".otf": "binary",
    ".svg": "text",
  },
  external: ["html-rewriter-wasm"],
  // Bundled CJS dependencies may call require() at runtime; ESM output needs
  // a real one in scope.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
