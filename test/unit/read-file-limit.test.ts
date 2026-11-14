import { afterEach, describe, expect, it, vi } from "vitest";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { createReadFileTool } from "../../src/tools.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

afterEach(() => vi.mocked(open).mockReset());

/** A file that reports one size at stat(), then serves different bytes at read(). */
function changingFile(size: bigint, contents: Buffer) {
  let position = 0;
  const handle = {
    stat: vi.fn().mockResolvedValue({ size }),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      const bytesRead = contents.copy(buffer, offset, position, position + length);
      position += bytesRead;
      return { bytesRead, buffer };
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(open).mockResolvedValue(handle as unknown as FileHandle);
  return handle;
}

describe("bounded file reads", () => {
  const path = resolve("growing-file.txt");
  const ctx = { callId: "limit", turn: 1 };

  it("rejects a known oversized file without allocating a read buffer", async () => {
    const handle = changingFile(100n, Buffer.from("not read"));
    await expect(createReadFileTool({ maxBytes: 5 }).execute({ path }, ctx)).rejects.toThrow("maximum size of 5 bytes");
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("reads at most limit plus one byte if a file grows after stat", async () => {
    const handle = changingFile(1n, Buffer.alloc(100_000, 65));
    await expect(createReadFileTool({ maxBytes: 70_000 }).execute({ path }, ctx)).rejects.toThrow("maximum size of 70000 bytes");
    expect(handle.read.mock.calls.map(call => call[2])).toEqual([65_536, 4465]);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("detects growth even with a zero-byte limit", async () => {
    const handle = changingFile(0n, Buffer.from("a"));
    await expect(createReadFileTool({ maxBytes: 0 }).execute({ path }, ctx)).rejects.toThrow("maximum size of 0 bytes");
    expect(handle.read.mock.calls[0]?.[2]).toBe(1);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("closes the file if stat or read fails", async () => {
    for (const stage of ["stat", "read"] as const) {
      const handle = changingFile(0n, Buffer.from("a"));
      handle[stage].mockRejectedValueOnce(new Error(`${stage} failed`));
      await expect(createReadFileTool({ maxBytes: 1 }).execute({ path }, ctx)).rejects.toThrow(`${stage} failed`);
      expect(handle.close).toHaveBeenCalledOnce();
    }
  });

  it("checks cancellation during bounded reads and closes the file", async () => {
    const handle = changingFile(0n, Buffer.from("a"));
    const controller = new AbortController();
    handle.read.mockImplementationOnce(async buffer => {
      controller.abort();
      return { bytesRead: 0, buffer };
    });
    await expect(createReadFileTool({ maxBytes: 10 }).execute({ path }, { ...ctx, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(handle.close).toHaveBeenCalledOnce();
  });
});
