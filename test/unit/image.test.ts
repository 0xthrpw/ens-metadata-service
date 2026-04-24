import { describe, expect, it } from "vitest";
import { assertUnderSizeLimit } from "../../src/services/image";
import { MAX_IMAGE_BYTES } from "../../src/constants";

describe("assertUnderSizeLimit", () => {
  it("accepts payloads at or under the limit", () => {
    expect(() => assertUnderSizeLimit(0)).not.toThrow();
    expect(() => assertUnderSizeLimit(MAX_IMAGE_BYTES)).not.toThrow();
  });

  it("throws an upstream error when the payload is larger than the limit", () => {
    expect(() => assertUnderSizeLimit(MAX_IMAGE_BYTES + 1)).toThrowError(
      /image exceeds size limit/,
    );
  });

  it("respects a custom limit override", () => {
    expect(() => assertUnderSizeLimit(101, 100)).toThrowError(
      /image exceeds size limit/,
    );
    expect(() => assertUnderSizeLimit(100, 100)).not.toThrow();
  });
});
