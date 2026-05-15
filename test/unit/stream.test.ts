import { describe, expect, it } from "vitest";
import { teeBranchToR2 } from "../../src/services/image/stream";

function streamOf(
  chunks: Uint8Array[],
  err?: unknown,
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) {
        c.enqueue(chunks[i++]!);
        return;
      }
      if (err !== undefined) {
        c.error(err);
        return;
      }
      c.close();
    },
  });
}

function collector() {
  const writes: Uint8Array[] = [];
  return {
    writes,
    write: async (b: ArrayBuffer) => {
      writes.push(new Uint8Array(b.slice(0)));
    },
  };
}

describe("teeBranchToR2", () => {
  it("known length, exact body: writes exactly once with the bytes", async () => {
    const { writes, write } = collector();
    await teeBranchToR2(
      streamOf([Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5])]),
      write,
      5,
    );
    expect(writes).toHaveLength(1);
    expect([...writes[0]!]).toEqual([1, 2, 3, 4, 5]);
  });

  it("known length, short body: writes the actual bytes (sized down)", async () => {
    const { writes, write } = collector();
    await teeBranchToR2(streamOf([Uint8Array.from([9, 9, 9])]), write, 8);
    expect(writes).toHaveLength(1);
    expect([...writes[0]!]).toEqual([9, 9, 9]);
  });

  it("known length, over-long body: does not cache (no partial)", async () => {
    const { writes, write } = collector();
    await teeBranchToR2(
      streamOf([Uint8Array.from([1, 2, 3, 4, 5, 6])]),
      write,
      4,
    );
    expect(writes).toHaveLength(0);
  });

  it("known length, erroring stream: does not cache", async () => {
    const { writes, write } = collector();
    await teeBranchToR2(
      streamOf([Uint8Array.from([1, 2])], new Error("aborted")),
      write,
      10,
    );
    expect(writes).toHaveLength(0);
  });

  it("unknown length (SVG path): concatenates all chunks", async () => {
    const { writes, write } = collector();
    await teeBranchToR2(
      streamOf([
        Uint8Array.from([10]),
        Uint8Array.from([20, 30]),
        Uint8Array.from([40]),
      ]),
      write,
    );
    expect(writes).toHaveLength(1);
    expect([...writes[0]!]).toEqual([10, 20, 30, 40]);
  });

  it("unknown length, erroring stream: does not cache", async () => {
    const { writes, write } = collector();
    await teeBranchToR2(
      streamOf([Uint8Array.from([1])], new Error("boom")),
      write,
    );
    expect(writes).toHaveLength(0);
  });
});
