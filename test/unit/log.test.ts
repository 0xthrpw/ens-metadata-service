import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, log, parseLevel, setDefaultLevel } from "../../src/lib/log";
import { notFound, upstream } from "../../src/lib/errors";

type Spies = Record<"debug" | "info" | "warn" | "error", ReturnType<typeof vi.spyOn>>;

function spyConsole(): Spies {
  return {
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

function lastJson(spy: ReturnType<typeof vi.spyOn>): any {
  const arg = spy.mock.calls.at(-1)?.[0] as string;
  return JSON.parse(arg);
}

afterEach(() => {
  vi.restoreAllMocks();
  setDefaultLevel("info"); // reset module-logger level between tests
});

describe("parseLevel", () => {
  it("normalizes and falls back to info", () => {
    expect(parseLevel("DEBUG")).toBe("debug");
    expect(parseLevel("warn")).toBe("warn");
    expect(parseLevel(undefined)).toBe("info");
    expect(parseLevel("nonsense")).toBe("info");
  });
});

describe("createLogger", () => {
  it("emits a single-line JSON object with level/event/time", () => {
    const s = spyConsole();
    createLogger().info("hello", { a: 1 });

    const arg = s.info.mock.calls[0]?.[0] as string;
    expect(arg).not.toContain("\n");
    const p = JSON.parse(arg);
    expect(p.level).toBe("info");
    expect(p.event).toBe("hello");
    expect(new Date(p.time).toISOString()).toBe(p.time);
    expect(p.a).toBe(1);
  });

  it("merges base then fields, with fields overriding base", () => {
    const s = spyConsole();
    createLogger({ reqId: "x", a: "base" }).warn("e", { a: "field", b: 2 });
    const p = lastJson(s.warn);
    expect(p.reqId).toBe("x");
    expect(p.a).toBe("field");
    expect(p.b).toBe(2);
  });

  it("gates below the minimum level before building JSON", () => {
    const s = spyConsole();
    const logger = createLogger({}, "warn");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("er");
    expect(s.debug).not.toHaveBeenCalled();
    expect(s.info).not.toHaveBeenCalled();
    expect(s.warn).toHaveBeenCalledOnce();
    expect(s.error).toHaveBeenCalledOnce();
  });

  it("defaults to info (debug suppressed)", () => {
    const s = spyConsole();
    const logger = createLogger();
    logger.debug("d");
    logger.info("i");
    expect(s.debug).not.toHaveBeenCalled();
    expect(s.info).toHaveBeenCalledOnce();
  });

  it("routes each level to the matching console method", () => {
    const s = spyConsole();
    const logger = createLogger({}, "debug");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("er");
    expect(s.debug).toHaveBeenCalledOnce();
    expect(s.info).toHaveBeenCalledOnce();
    expect(s.warn).toHaveBeenCalledOnce();
    expect(s.error).toHaveBeenCalledOnce();
  });

  it("serializes a plain Error with a capped stack", () => {
    const s = spyConsole();
    createLogger().error("boom", { err: new Error("nope") });
    const p = lastJson(s.error);
    expect(p.err.name).toBe("Error");
    expect(p.err.message).toBe("nope");
    expect(typeof p.err.stack).toBe("string");
    expect(p.err.stack.length).toBeLessThanOrEqual(1000);
    expect(p.err.status).toBeUndefined();
  });

  it("serializes HttpError with status and code", () => {
    const s = spyConsole();
    createLogger().error("e", { err: upstream("nope") });
    let p = lastJson(s.error);
    expect(p.err.name).toBe("HttpError");
    expect(p.err.status).toBe(502);
    expect(p.err.code).toBe("upstream_error");

    createLogger().error("e", { err: notFound("missing") });
    p = lastJson(s.error);
    expect(p.err.status).toBe(404);
    expect(p.err.code).toBe("not_found");
  });

  it("recurses into Error.cause exactly one level", () => {
    const s = spyConsole();
    const deep = new Error("L2", { cause: new Error("L3") });
    createLogger().error("e", { err: upstream("L1", deep) });
    const p = lastJson(s.error);
    expect(p.err.message).toBe("L1");
    expect(p.err.cause.message).toBe("L2");
    expect(p.err.cause.cause).toBeUndefined();
  });

  it("is circular-safe", () => {
    const s = spyConsole();
    const o: any = { k: 1 };
    o.self = o;
    expect(() => createLogger().info("e", { ctx: o })).not.toThrow();
    const p = lastJson(s.info);
    expect(p.ctx.k).toBe(1);
    expect(p.ctx.self).toBe("[Circular]");
  });

  it("stringifies bigint", () => {
    const s = spyConsole();
    createLogger().info("e", { tokenId: 123n });
    expect(lastJson(s.info).tokenId).toBe("123");
  });

  it("never throws and still emits an event line", () => {
    const s = spyConsole();
    const bad = {
      toJSON() {
        throw new Error("toJSON boom");
      },
    };
    expect(() => createLogger().info("evt", { bad })).not.toThrow();
    const p = lastJson(s.info);
    expect(p.event).toBe("evt");
  });

  it("caps oversized output", () => {
    const s = spyConsole();
    createLogger().info("big", { blob: "x".repeat(20000) });
    const arg = s.info.mock.calls[0]?.[0] as string;
    const p = JSON.parse(arg);
    expect(p.truncated).toBe(true);
    expect(arg.length).toBeLessThan(16 * 1024 + 512);
  });

  it("child merges extra base fields", () => {
    const s = spyConsole();
    createLogger({ reqId: "r" }).child({ scope: "sub" }).info("e");
    const p = lastJson(s.info);
    expect(p.reqId).toBe("r");
    expect(p.scope).toBe("sub");
  });

  it("module default logger emits at info", () => {
    const s = spyConsole();
    log.info("singleton");
    expect(lastJson(s.info).event).toBe("singleton");
  });

  it("module default logger suppresses debug at the default level", () => {
    const s = spyConsole();
    log.debug("seam");
    expect(s.debug).not.toHaveBeenCalled();
  });

  it("setDefaultLevel('debug') makes the module logger emit debug", () => {
    const s = spyConsole();
    setDefaultLevel("debug");
    log.debug("seam", { scheme: "ipfs" });
    expect(lastJson(s.debug).event).toBe("seam");
    expect(lastJson(s.debug).scheme).toBe("ipfs");
  });

  it("setDefaultLevel also gates children of the module logger", () => {
    const s = spyConsole();
    log.child({ a: 1 }).debug("child-seam");
    expect(s.debug).not.toHaveBeenCalled();
    setDefaultLevel("debug");
    log.child({ a: 1 }).debug("child-seam");
    expect(lastJson(s.debug).event).toBe("child-seam");
    expect(lastJson(s.debug).a).toBe(1);
  });
});
