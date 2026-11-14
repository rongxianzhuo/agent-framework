#!/usr/bin/env node
/**
 * Structural invariants for agent-framework.
 *
 * These are the promises in the README that a reviewer cannot reliably catch by
 * reading a diff. Each one turns into a failing check here, so the repository
 * rots loudly instead of quietly.
 *
 *   1. The only runtime dependency is the `openai` SDK, used by one adapter.
 *   2. Only concrete provider adapters may import external packages.
 *   3. Modules respect the core, tools, runtime, builtins and provider boundaries.
 *   4. Every entry point lists its exports explicitly; no `export *`.
 *   5. No credential is committed.
 *   6. The core entry point does not reach providers, built-ins or the conformance suite.
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

// 1. Exactly one runtime dependency, and it is the vendor SDK.
//
// The rule used to be "zero". It became "one, the official OpenAI SDK" when the
// adapter moved onto `openai`: writing the SSE framer by hand was a maintenance
// burden and a source of protocol drift. The property that actually mattered —
// that importing the core does not load a vendor library — is checked separately
// and transitively below, which is a stronger statement than counting
// dependencies.
const ALLOWED_DEPENDENCIES = new Set(["openai"]);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const deps = Object.keys(pkg.dependencies ?? {});
for (const dep of deps) {
  if (!ALLOWED_DEPENDENCIES.has(dep)) {
    failures.push(`package.json declares an unexpected runtime dependency: ${dep}`);
  }
}

// 2 and 3. Import discipline.
const importRe = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const allowedLayers = {
  core: new Set(["core"]),
  tools: new Set(["core", "tools"]),
  runtime: new Set(["core", "tools", "runtime"]),
  builtins: new Set(["core", "tools", "builtins"]),
  "providers/shared": new Set(["core", "providers/shared"]),
};

function layerOf(path) {
  const parts = path.replace(/^src\//, "").split("/");
  return parts[0] === "providers" ? parts.slice(0, 2).join("/") : parts[0];
}

for (const file of srcFiles) {
  const rel = relative(root, file).replaceAll("\\", "/");
  const source = readFileSync(file, "utf8");
  const layer = layerOf(rel);
  const isAdapter = rel.startsWith("src/providers/") && layer !== "providers/shared";
  const allowed = allowedLayers[layer] ??
    (isAdapter ? new Set(["core", "providers/shared", layer]) : undefined);

  for (const match of source.matchAll(importRe)) {
    const spec = match[1];
    if (spec.startsWith("node:")) continue;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const target = relative(root, resolve(dirname(file), spec)).replaceAll("\\", "/");
      if (allowed !== undefined && !allowed.has(layerOf(target))) {
        failures.push(`${rel} imports ${spec}; ${layer} may only depend on ${[...allowed].join(", ")}`);
      }
      continue;
    }
    // Shared provider helpers are dependency-free and may be exported by the
    // core entry point. Only concrete adapters may load an external SDK.
    if (!isAdapter) {
      failures.push(`${rel} imports a bare module ("${spec}"); only concrete provider adapters may do that`);
    } else if (!ALLOWED_DEPENDENCIES.has(spec.split("/")[0])) {
      failures.push(`${rel} imports "${spec}", which is neither a Node builtin nor the allowed SDK`);
    }
  }
}

// 4. Explicit exports only, in every entry point. Comments are stripped first so
// that prose about the rule (this file's own README text, for instance) does not
// trip the check.
const ENTRY_POINTS = ["index", "openai", "faux", "conformance", "tools"];

for (const name of ENTRY_POINTS) {
  const path = join(root, "src", `${name}.ts`);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    failures.push(`entry point src/${name}.ts is missing; package.json exports refer to it`);
    continue;
  }

  const stripped = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
  if (/export\s*\*/.test(stripped)) {
    failures.push(`src/${name}.ts uses \`export *\`; list every export explicitly`);
  }
}

// 6. The core entry point must not drag a provider or the conformance suite into
// an embedding agent's process. Checked transitively through the relative import
// graph rooted at src/index.ts, not just the file's own imports: a two-hop path
// is exactly how this would slip back in.
const CORE_FORBIDDEN = [/^src\/providers\/(?!shared\/)/, /^src\/testing\//, /^src\/builtins\//, /^src\/tools\.ts$/];
const coreVisited = new Set();
const coreQueue = [join(root, "src/index.ts")];

while (coreQueue.length > 0) {
  const file = coreQueue.pop();
  const rel = relative(root, file).replaceAll("\\", "/");
  if (coreVisited.has(rel)) continue;
  coreVisited.add(rel);

  for (const pattern of CORE_FORBIDDEN) {
    if (pattern.test(rel)) {
      failures.push(`${rel} is reachable from src/index.ts; the core entry point must not load optional modules`);
    }
  }

  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const match of source.matchAll(importRe)) {
    const spec = match[1];
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    // `.js` in the source, `.ts` on disk.
    const target = resolve(dirname(file), spec).replace(/\.js$/, ".ts");
    coreQueue.push(target);
  }
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
  `Invariants OK: ${srcFiles.length} source files, ${ENTRY_POINTS.length} entry points, ${tracked.length} tracked files, runtime dependencies: ${deps.join(", ") || "none"}, no committed credentials.`,
);
