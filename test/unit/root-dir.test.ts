import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeTool } from "../../src/index.js";
import {
  createEditFileTool,
  createReadFileTool,
  createReadImageTool,
  createWriteFileTool,
} from "../../src/tools.js";

const prefix = resolve(tmpdir(), "agent-framework-root-dir-");
let root: string;
let outside: string;
const ctx = { callId: "root", turn: 1 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5E8AAAAASUVORK5CYII=", "base64");

beforeAll(async () => {
  const base = await mkdtemp(prefix);
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "text.txt"), "inside");
  await writeFile(join(root, "nested", "deep.txt"), "deep");
  await writeFile(join(root, "picture.png"), png);
  await writeFile(join(outside, "secret.txt"), "secret");
});

afterAll(async () => {
  if (root === undefined) return;
  if (!resolve(root).startsWith(prefix)) throw new Error("Unexpected fixture directory");
  await rm(resolve(root, ".."), { recursive: true, force: true });
});

describe("rootDir path resolution", () => {
  it("resolves a plain relative path against rootDir", async () => {
    const result = await createReadFileTool({ rootDir: root }).execute({ path: "text.txt" }, ctx);
    expect(result.content).toEqual([{ type: "text", text: "inside" }]);
  });

  it("resolves a nested relative path and a ./ prefix", async () => {
    const tool = createReadFileTool({ rootDir: root });
    expect((await tool.execute({ path: "nested/deep.txt" }, ctx)).content).toEqual([{ type: "text", text: "deep" }]);
    expect((await tool.execute({ path: "./text.txt" }, ctx)).content).toEqual([{ type: "text", text: "inside" }]);
  });

  it("treats the root itself as in bounds and its parent as outside", async () => {
    const tool = createReadFileTool({ rootDir: join(root, "nested") });
    await expect(tool.execute({ path: ".." }, ctx)).rejects.toThrow("must stay inside");
    await expect(tool.execute({ path: "." }, ctx)).rejects.toThrow(/EISDIR|illegal operation/);
  });

  it("rejects a parent traversal that leaves the root", async () => {
    const tool = createReadFileTool({ rootDir: root });
    await expect(tool.execute({ path: "../outside/secret.txt" }, ctx)).rejects.toThrow("must stay inside");
    for (const path of ["nested/../../outside/secret.txt", "nested/../../../etc/passwd"]) {
      await expect(tool.execute({ path }, ctx)).rejects.toThrow("must stay inside");
    }
  });

  it("rejects an absolute path that points outside the root", async () => {
    const tool = createReadFileTool({ rootDir: root });
    await expect(tool.execute({ path: join(outside, "secret.txt") }, ctx)).rejects.toThrow("must stay inside");
    await expect(tool.execute({ path: "/etc/passwd" }, ctx)).rejects.toThrow("must stay inside");
  });

  it("accepts an absolute path that points inside the root", async () => {
    const result = await createReadFileTool({ rootDir: root }).execute({ path: join(root, "nested", "deep.txt") }, ctx);
    expect(result.content).toEqual([{ type: "text", text: "deep" }]);
  });

  it("does not treat a sibling directory with the same prefix as inside", async () => {
    const sibling = `${root}-other`;
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "file.txt"), "sibling");
    const tool = createReadFileTool({ rootDir: root });
    await expect(tool.execute({ path: join(sibling, "file.txt") }, ctx)).rejects.toThrow("must stay inside");
    await rm(sibling, { recursive: true, force: true });
  });

  it("resolves the image reader through rootDir", async () => {
    const result = await createReadImageTool({ rootDir: root }).execute({ path: "picture.png" }, ctx);
    expect(result.content).toEqual([{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
    await expect(createReadImageTool({ rootDir: root }).execute({ path: "../outside/secret.txt" }, ctx))
      .rejects.toThrow("must stay inside");
  });

  it("resolves the writer through rootDir and reports the resolved path", async () => {
    const tool = createWriteFileTool({ rootDir: root });
    const result = await tool.execute({ path: "nested/written.txt", content: "written" }, ctx);
    expect(await readFile(join(root, "nested", "written.txt"), "utf8")).toBe("written");
    expect(result.content).toEqual([{ type: "text", text: `Wrote 7 bytes to ${absolute("nested/written.txt")}.` }]);
    await expect(tool.execute({ path: "../outside/escape.txt", content: "no" }, ctx)).rejects.toThrow("must stay inside");
  });

  it("resolves the editor through rootDir for both read and write", async () => {
    const path = join(root, "nested", "edited.txt");
    await writeFile(path, "old text");
    const result = await createEditFileTool({ rootDir: root }).execute(
      { file_path: "nested/edited.txt", old_string: "old", new_string: "new" },
      ctx,
    );
    expect(await readFile(path, "utf8")).toBe("new text");
    expect(result.content).toEqual([{ type: "text", text: `Replaced 1 occurrence in ${path}.` }]);
    await expect(createEditFileTool({ rootDir: root }).execute(
      { file_path: "../outside/secret.txt", old_string: "secret", new_string: "leaked" },
      ctx,
    )).rejects.toThrow("must stay inside");
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("reports escapes as ordinary tool failures rather than throwing past the executor", async () => {
    const tool = createReadFileTool({ rootDir: root });
    const outcome = await executeTool(tool, { id: "t", name: tool.name, args: { path: "../outside/secret.txt" } }, ctx);
    expect(outcome.message.isError).toBe(true);
    expect(outcome.error?.kind).toBe("toolFailed");
    expect(outcome.message.content[0]).toMatchObject({ text: expect.stringContaining("must stay inside") });
  });

  it("rejects a rootDir that is not an absolute path", () => {
    for (const rootDir of ["", "relative", "./root", "."]) {
      expect(() => createReadFileTool({ rootDir })).toThrow("rootDir must be an absolute directory path");
    }
    expect(() => createReadImageTool({ rootDir: "relative" })).toThrow("rootDir must be an absolute directory path");
    expect(() => createWriteFileTool({ rootDir: "relative" })).toThrow("rootDir must be an absolute directory path");
    expect(() => createEditFileTool({ rootDir: "relative" })).toThrow("rootDir must be an absolute directory path");
  });

  it("describes the active path rule to the model", () => {
    expect(createReadFileTool().description).toContain("An absolute path is required.");
    expect(createReadFileTool({ rootDir: root }).description).toContain(`Paths are relative to ${root} and must stay inside it.`);
    for (const tool of [
      createReadImageTool({ rootDir: root }),
      createWriteFileTool({ rootDir: root }),
      createEditFileTool({ rootDir: root }),
    ]) {
      expect(tool.description).toContain("Paths are relative to");
    }
  });

  it("keeps requiring absolute paths when rootDir is omitted", async () => {
    await expect(createReadFileTool().execute({ path: "text.txt" }, ctx)).rejects.toThrow("absolute file path");
    await expect(createWriteFileTool().execute({ path: "text.txt", content: "x" }, ctx)).rejects.toThrow("absolute file path");
    await expect(createEditFileTool().execute({ file_path: "text.txt", old_string: "a", new_string: "b" }, ctx))
      .rejects.toThrow("absolute file path");
    await expect(createReadImageTool().execute({ path: "picture.png" }, ctx)).rejects.toThrow("absolute file path");
  });

  it("rejects an empty path when rootDir is set", async () => {
    await expect(createReadFileTool({ rootDir: root }).execute({ path: "" }, ctx)).rejects.toThrow("nonempty file path");
  });
});

function absolute(...parts: string[]): string {
  return join(root, ...parts);
}
