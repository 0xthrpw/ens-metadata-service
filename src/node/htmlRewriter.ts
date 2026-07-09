// Node polyfill for the Workers HTMLRewriter global, backed by
// html-rewriter-wasm (the same lol-html wasm build miniflare v2 used to
// emulate Workers). Only the surface sanitize.ts uses is exposed:
// `.on(selector, handlers)` and `.transform(response)`. Handler objects and
// Element semantics (attributes iterator, removeAttribute, remove, tagName)
// pass straight through to the wasm binding, so the sanitizer policy runs
// identically on both runtimes.
import {
  HTMLRewriter as RawHTMLRewriter,
  type ElementHandlers,
} from "html-rewriter-wasm";

class NodeHTMLRewriter {
  #handlers: Array<[string, ElementHandlers]> = [];

  on(selector: string, handlers: ElementHandlers): this {
    this.#handlers.push([selector, handlers]);
    return this;
  }

  transform(response: Response): Response {
    const handlers = this.#handlers;
    const src = response.body;
    const out = new ReadableStream<Uint8Array>({
      async start(controller) {
        const rewriter = new RawHTMLRewriter((chunk) => {
          // The sink chunk is a view into wasm memory that is reused after
          // the callback returns — copy before handing it downstream.
          if (chunk.length > 0) controller.enqueue(new Uint8Array(chunk));
        });
        for (const [selector, h] of handlers) rewriter.on(selector, h);
        try {
          if (src) {
            const reader = src.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              await rewriter.write(value);
            }
          }
          await rewriter.end();
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          rewriter.free();
        }
      },
    });
    return new Response(out, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

export function installHtmlRewriter(): void {
  if (!("HTMLRewriter" in globalThis)) {
    (globalThis as Record<string, unknown>).HTMLRewriter = NodeHTMLRewriter;
  }
}
