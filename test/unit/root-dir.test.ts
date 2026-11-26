import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

  it("resolves the writer through rootDir and echoes the supplied path", async () => {
    const tool = createWriteFileTool({ rootDir: root });
    const result = await tool.execute({ path: "nested/written.txt", content: "written" }, ctx);
    expect(await readFile(join(root, "nested", "written.txt"), "utf8")).toBe("written");
    expect(result.content).toEqual([{ type: "text", text: "Wrote 7 bytes to nested/written.txt." }]);
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
    expect(result.content).toEqual([{ type: "text", text: "Replaced 1 occurrence in nested/edited.txt." }]);
    await expect(createEditFileTool({ rootDir: root }).execute(
      { file_path: "../outside/secret.txt", old_string: "secret", new_string: "leaked" },
      ctx,
    )).rejects.toThrow("must stay inside");
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("never reveals the root directory in a description or a result", async () => {
    const tools = [
      createReadFileTool({ rootDir: root }),
      createReadImageTool({ rootDir: root }),
      createWriteFileTool({ rootDir: root }),
      createEditFileTool({ rootDir: root }),
    ];
    for (const tool of tools) {
      expect(JSON.stringify(tool.parameters)).not.toContain(root);
      expect(tool.description).not.toContain(root);
    }
    const failed = await executeTool(
      tools[0]!,
      { id: "t", name: "read_file", args: { path: "../outside/secret.txt" } },
      ctx,
    );
    expect(JSON.stringify(failed.message)).not.toContain(root);
    const written = await createWriteFileTool({ rootDir: root }).execute({ path: "probe.txt", content: "x" }, ctx);
    const edited = await createEditFileTool({ rootDir: root }).execute(
      { file_path: "probe.txt", old_string: "x", new_string: "y" },
      ctx,
    );
    expect(JSON.stringify([written, edited])).not.toContain(root);
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
    const rule = "Paths are resolved against the tool's root directory and must stay inside it.";
    for (const tool of [
      createReadFileTool({ rootDir: root }),
      createReadImageTool({ rootDir: root }),
      createWriteFileTool({ rootDir: root }),
      createEditFileTool({ rootDir: root }),
    ]) {
      expect(tool.description).toContain(rule);
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

describe.skipIf(process.platform === "win32")("symbolic links under rootDir", () => {
  it("rejects a link to a file outside the root", async () => {
    const link = join(root, "escape.txt");
    await symlink(join(outside, "secret.txt"), link);
    await expect(createReadFileTool({ rootDir: root }).execute({ path: "escape.txt" }, ctx))
      .rejects.toThrow("must stay inside");
    await expect(createReadImageTool({ rootDir: root }).execute({ path: "escape.txt" }, ctx))
      .rejects.toThrow("must stay inside");
  });

  it("rejects a directory link that escapes, for reads and writes", async () => {
    const link = join(root, "escape-dir");
    await symlink(outside, link, "dir");
    await expect(createReadFileTool({ rootDir: root }).execute({ path: "escape-dir/secret.txt" }, ctx))
      .rejects.toThrow("must stay inside");
    await expect(createWriteFileTool({ rootDir: root }).execute({ path: "escape-dir/planted.txt", content: "x" }, ctx))
      .rejects.toThrow("must stay inside");
    await expect(createEditFileTool({ rootDir: root }).execute(
      { file_path: "escape-dir/secret.txt", old_string: "secret", new_string: "leaked" },
      ctx,
    )).rejects.toThrow("must stay inside");
    await expect(stat(join(outside, "planted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("rejects a link inside the root that points back outside through several hops", async () => {
    await symlink(outside, join(root, "hop1"), "dir");
    await symlink(join(root, "hop1"), join(root, "hop2"), "dir");
    await expect(createReadFileTool({ rootDir: root }).execute({ path: "hop2/secret.txt" }, ctx))
      .rejects.toThrow("must stay inside");
  });

  it("allows a link to a file inside the root", async () => {
    await symlink(join(root, "nested", "deep.txt"), join(root, "alias.txt"));
    const result = await createReadFileTool({ rootDir: root }).execute({ path: "alias.txt" }, ctx);
    expect(result.content).toEqual([{ type: "text", text: "deep" }]);
  });

  it("resolves rootDir itself through a link before comparing", async () => {
    const link = join(resolve(root, ".."), "root-link");
    await symlink(root, link, "dir");
    const tool = createReadFileTool({ rootDir: link });
    expect((await tool.execute({ path: "text.txt" }, ctx)).content).toEqual([{ type: "text", text: "inside" }]);
    await expect(tool.execute({ path: "../outside/secret.txt" }, ctx)).rejects.toThrow("must stay inside");
    await rm(link, { force: true });
  });

  it("rejects a dangling link whose target lies outside the root", async () => {
    const link = join(root, "dangling.txt");
    await symlink(join(outside, "not-there.txt"), link);
    await expect(createWriteFileTool({ rootDir: root }).execute({ path: "dangling.txt", content: "x" }, ctx))
      .rejects.toThrow("must stay inside");
    await expect(stat(join(outside, "not-there.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves links unrestricted when the tool has no rootDir", async () => {
    const link = join(root, "open-escape.txt");
    await symlink(join(outside, "secret.txt"), link);
    const result = await createReadFileTool().execute({ path: link }, ctx);
    expect(result.content).toEqual([{ type: "text", text: "secret" }]);
  });
});
