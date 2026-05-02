const DANGEROUS_TAGS =
  "script, foreignObject, iframe, object, embed, link, meta, form, input, textarea, button, base";

const URL_ATTRS = new Set(["href", "xlink:href", "src", "action", "formaction"]);
const DANGEROUS_SCHEMES = /^(javascript|vbscript|data|file):/;
const SAFE_EMBEDDED_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const ASCII_WHITESPACE_AND_C0 = /[\u0000-\u0020]+/g;
const NAMED_HTML_REFS = new Map([
  ["colon", ":"],
  ["newline", "\n"],
  ["tab", "\t"],
]);

function decodeHtmlCharRefs(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|colon|newline|tab);?/gi,
    (match, ref: string) => {
      const lowerRef = ref.toLowerCase();
      if (!lowerRef.startsWith("#")) {
        return NAMED_HTML_REFS.get(lowerRef) ?? match;
      }

      const codePoint = lowerRef.startsWith("#x")
        ? Number.parseInt(lowerRef.slice(2), 16)
        : Number.parseInt(lowerRef.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return match;
      }

      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    },
  );
}

function normalizeUrlForSchemeCheck(value: string): string {
  return decodeHtmlCharRefs(value).toLowerCase().replace(ASCII_WHITESPACE_AND_C0, "");
}

function hasDangerousScheme(value: string): boolean {
  return DANGEROUS_SCHEMES.test(normalizeUrlForSchemeCheck(value));
}

function isSafeEmbeddedImage(el: Element, name: string, value: string): boolean {
  const attr = name.toLowerCase();
  return (
    el.tagName.toLowerCase() === "image" &&
    (attr === "href" || attr === "xlink:href" || attr === "src") &&
    SAFE_EMBEDDED_IMAGE.test(value)
  );
}

class RemoveElement {
  element(el: Element) {
    el.remove();
  }
}

class SanitizeAttributes {
  element(el: Element) {
    for (const [name, value] of [...el.attributes]) {
      if (name === undefined) continue;
      if (/^on/i.test(name)) {
        el.removeAttribute(name);
        continue;
      }
      if (
        URL_ATTRS.has(name.toLowerCase()) &&
        value !== undefined &&
        !isSafeEmbeddedImage(el, name, value) &&
        hasDangerousScheme(value)
      ) {
        el.removeAttribute(name);
      }
    }
  }
}

function sanitizeResponse(res: Response): Response {
  return new HTMLRewriter()
    .on(DANGEROUS_TAGS, new RemoveElement())
    .on("*", new SanitizeAttributes())
    .transform(res);
}

export async function sanitizeSvg(svg: string): Promise<string> {
  return sanitizeResponse(
    new Response(svg, { headers: { "content-type": "text/html; charset=utf-8" } }),
  ).text();
}

export function sanitizeSvgStream(
  src: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const out = sanitizeResponse(
    new Response(src, { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  if (!out.body) throw new Error("HTMLRewriter returned empty body");
  return out.body;
}
