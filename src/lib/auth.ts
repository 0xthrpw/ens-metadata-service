import type { Context } from "hono";
import type { Env } from "../env";
import { HttpError } from "./errors";

/**
 * Requires a bearer token matching `expected`. Throws HttpError(503) if the
 * expected token is unset (so we never accidentally expose a route on a
 * deploy that hasn't configured its secrets) and HttpError(401) otherwise.
 */
export function requireBearerToken(
  c: Context<{ Bindings: Env }>,
  expected: string | undefined,
  configLabel: string,
): void {
  if (!expected) {
    throw new HttpError(503, `${configLabel} not configured`, "not_configured");
  }
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1];
  if (!token || !timingSafeEqual(token, expected)) {
    throw new HttpError(401, "unauthorized", "unauthorized");
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
