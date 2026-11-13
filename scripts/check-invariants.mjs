#!/usr/bin/env node
/**
 * Structural invariants for agent-core.
 *
 * These are the promises in the README that a reviewer cannot reliably catch by
 * reading a diff. Each one turns into a failing check here, so the repository
 * rots loudly instead of quietly.
 *
 *   1. The published package has no runtime dependencies.
 *   2. `src/` imports nothing outside Node builtins and its own relative files.
 *   3. Core modules never import a provider adapter.
 *   4. `src/index.ts` lists its exports explicitly; no `export *`.
 *   5. No credential is committed.
 *
 * Run directly (`node scripts/check-invariants.mjs`) or via `npm run check`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const srcFiles = walk(join(root, "src"));

// 1. No runtime dependencies.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const deps = Object.keys(pkg.dependencies ?? {});
if (deps.length > 0) {
  failures.push(`package.json declares runtime dependencies: ${deps.join(", ")}`);
}

// 2 and 3. Import discipline.
const importRe = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const coreModules = new Set(["types", "errors", "events", "loop", "hooks", "tools", "schema", "client"]);

for (const file of srcFiles) {
  const rel = relative(root, file).replaceAll("\\", "/");
  const source = readFileSync(file, "utf8");
  const isCore = coreModules.has(rel.replace(/^src\//, "").replace(/\.ts$/, ""));

  for (const match of source.matchAll(importRe)) {
    const spec = match[1];
    if (spec.startsWith("node:")) continue;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const target = resolve(dirname(file), spec);
      if (isCore && target.includes("/providers/")) {
        failures.push(`${rel} imports a provider (${spec}); core must stay provider-free`);
      }
      continue;
    }
    failures.push(`${rel} imports a bare module ("${spec}"); use Node builtins or relative paths`);
  }
}

// 4. Explicit exports only. Comments are stripped first so that prose about the
// rule (this file's own README text, for instance) does not trip the check.
const entry = readFileSync(join(root, "src/index.ts"), "utf8")
  .replaceAll(/\/\*[\s\S]*?\*\//g, "")
  .replaceAll(/\/\/[^\n]*/g, "");
if (/export\s*\*/.test(entry)) {
  failures.push("src/index.ts uses `export *`; list every export explicitly");
}

// 5. No credentials in anything git would commit. Checked against the tracked
// file list, so a local .env is irrelevant and a staged key is caught before it
// leaves the machine. Only the file and line are reported — echoing the match
// would put the secret in a log, which is the thing being prevented.
const SECRET_PATTERNS = [
  { name: "an OpenAI-style API key", re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: "a bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
];

let tracked = [];
try {
  tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
} catch {
  // Not a git checkout (a published tarball, a CI export). Nothing to scan.
}

for (const file of tracked) {
  // This script necessarily contains the patterns themselves.
  if (file === "scripts/check-invariants.mjs") continue;
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(line)) {
        failures.push(`${file}:${index + 1} looks like it contains ${name}; remove it and rotate the credential`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Invariant check failed:\n");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `Invariants OK: ${srcFiles.length} source files, ${tracked.length} tracked files, zero runtime dependencies, no committed credentials.`,
);
