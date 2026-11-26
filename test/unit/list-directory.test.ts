import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeTool } from "../../src/index.js";
import { createListDirectoryTool } from "../../src/tools.js";

const prefix = resolve(tmpdir(), "agent-framework-list-");
let root: string;
let outside: string;
const ctx = { callId: "list", turn: 1 };

beforeAll(async () => {
  const base = await mkdtemp(prefix);
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret");

  await mkdir(join(root, "flat", "docs"), { recursive: true });
  await mkdir(join(root, "flat", "src", "nested"), { recursive: true });
  await writeFile(join(root, "flat", "readme.md"), "hi");
  await writeFile(join(root, "flat", "a.txt"), "a");
  await writeFile(join(root, "flat", "docs", "guide.md"), "guide");
  await writeFile(join(root, "flat", "src", "index.ts"), "export {};");
  await writeFile(join(root, "flat", "src", "nested", "deep.ts"), "deep");

  await mkdir(join(root, "counts"));
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
    await writeFile(join(root, "counts", name), name);
  }

  await mkdir(join(root, "empty"));
});

afterAll(async () => {
  if (root === undefined) return;
  if (!resolve(root).startsWith(prefix)) throw new Error("Unexpected fixture directory");
  await rm(resolve(root, ".."), { recursive: true, force: true });
});

function lines(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string[] {
  return (result.content[0]?.text ?? "").split("\n");
}

describe("list_directory", () => {
  it("lists one level, sorted, marking directories", async () => {
    const result = await createListDirectoryTool({ rootDir: root }).execute({ path: "flat" }, ctx);
    expect(lines(result)).toEqual(["a.txt", "docs/", "readme.md", "src/"]);
  });

  it("lists the root itself with a dot", async () => {
    const result = await createListDirectoryTool({ rootDir: root }).execute({ path: "." }, ctx);
    expect(lines(result)).toEqual(["counts/", "empty/", "flat/"]);
  });

  it("does not descend into subdirectories", async () => {
    const result = await createListDirectoryTool({ rootDir: root }).execute({ path: "flat/src" }, ctx);
    expect(lines(result)).toEqual(["index.ts", "nested/"]);
    expect(JSON.stringify(result)).not.toContain("deep.ts");
  });

  it("lists an absolute path inside the root", async () => {
    const result = await createListDirectoryTool({ rootDir: root }).execute({ path: join(root, "flat", "docs") }, ctx);
    expect(lines(result)).toEqual(["guide.md"]);
  });

  it("returns a message for an empty directory", async () => {
    const result = await createListDirectoryTool({ rootDir: root }).execute({ path: "empty" }, ctx);
    expect(result.content).toEqual([{ type: "text", text: "The directory is empty." }]);
  });

  it("rejects a path that leaves the root", async () => {
    const tool = createListDirectoryTool({ rootDir: root });
    for (const path of ["..", "../outside", outside]) {
      await expect(tool.execute({ path }, ctx)).rejects.toThrow("must stay inside");
    }
  });

  it("rejects listing a parent directory that would expose sibling names", async () => {
    const tool = createListDirectoryTool({ rootDir: join(root, "flat") });
    await expect(tool.execute({ path: ".." }, ctx)).rejects.toThrow("must stay inside");
  });

  it("never reveals the root or an absolute path", async () => {
    const tool = createListDirectoryTool({ rootDir: root });
    expect(tool.description).not.toContain(root);
    const listed = await tool.execute({ path: "flat/src" }, ctx);
    expect(JSON.stringify(listed)).not.toContain(root);
    expect(JSON.stringify(listed)).not.toContain(resolve(root));
  });

  it("hides the root when the directory does not exist", async () => {
    const tool = createListDirectoryTool({ rootDir: root });
    const outcome = await executeTool(tool, { id: "l", name: tool.name, args: { path: "flat/missing" } }, ctx);
    expect(outcome.message.isError).toBe(true);
    expect(outcome.error?.kind).toBe("toolFailed");
    const text = JSON.stringify(outcome.message);
    expect(text).toContain("missing");
    expect(text).not.toContain(root);
  });

  it("reports a file argument without leaking its absolute path", async () => {
    const tool = createListDirectoryTool({ rootDir: root });
    const outcome = await executeTool(tool, { id: "l", name: tool.name, args: { path: "flat/readme.md" } }, ctx);
    expect(outcome.message.isError).toBe(true);
    const text = JSON.stringify(outcome.message);
    expect(text).toContain("readme.md");
    expect(text).not.toContain(root);
  });

  it("caps the entry count and says how many were withheld", async () => {
    const tool = createListDirectoryTool({ rootDir: root, maxEntries: 2 });
    const result = await tool.execute({ path: "counts" }, ctx);
    expect(lines(result)).toEqual(["a.txt", "b.txt", "... 2 more entries not shown."]);
  });

  it("returns only a count when maxEntries is zero", async () => {
    const tool = createListDirectoryTool({ rootDir: root, maxEntries: 0 });
    const result = await tool.execute({ path: "counts" }, ctx);
    expect(lines(result)).toEqual(["... 4 more entries not shown."]);
  });

  it("rejects an invalid maxEntries", () => {
    expect(() => createListDirectoryTool({ maxEntries: -1 })).toThrow("maxEntries must be a non-negative safe integer");
    expect(() => createListDirectoryTool({ maxEntries: 1.5 })).toThrow("maxEntries must be a non-negative safe integer");
  });

  it("requires an absolute path when rootDir is omitted", async () => {
    await expect(createListDirectoryTool().execute({ path: "flat" }, ctx)).rejects.toThrow("absolute file path");
    const result = await createListDirectoryTool().execute({ path: join(root, "flat") }, ctx);
    expect(lines(result)).toContain("a.txt");
  });

  it("stops promptly when the run is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createListDirectoryTool({ rootDir: root }).execute(
      { path: "flat" },
      { ...ctx, signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe.skipIf(process.platform === "win32")("list_directory and symbolic links", () => {
  it("marks a link instead of following it", async () => {
    await mkdir(join(root, "links"));
    await symlink(outside, join(root, "links", "link-out"), "dir");
    const result = await createListDirectoryTool({ rootDir: root }).execute({ path: "links" }, ctx);
    expect(lines(result)).toEqual(["link-out@"]);
  });

  it("refuses to list a link that escapes the root", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "links", "link-file"));
    const tool = createListDirectoryTool({ rootDir: root });
    await expect(tool.execute({ path: "links/link-out" }, ctx)).rejects.toThrow("must stay inside");
    await expect(tool.execute({ path: "links/link-file" }, ctx)).rejects.toThrow("must stay inside");
  });

  it("lists a link that stays inside the root", async () => {
    await symlink(join(root, "flat", "docs"), join(root, "links", "link-in"), "dir");
    const result = await createListDirectoryTool({ rootDir: root }).execute({ path: "links/link-in" }, ctx);
    expect(lines(result)).toEqual(["guide.md"]);
  });
});
