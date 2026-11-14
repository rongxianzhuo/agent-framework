#!/usr/bin/env node
/**
 * Verify the package as a consumer receives it.
 *
 * Every other check in this repository looks at the source or the built output.
 * This one answers the question those cannot: after `npm install agent-core`,
 * does it work? So it builds, packs a tarball, installs that tarball into a
 * throwaway project in the OS temp directory, and runs the fixtures in
 * `scripts/consumer/` against it by package name.
 *
 * What this catches that nothing else does:
 *
 *   - an `exports` map that points at a file the build does not produce
 *   - a subpath the source has but `exports` forgets, or the reverse
 *   - type declarations that resolve but do not compile under a strict consumer
 *   - source or tests leaking into the tarball through `files`
 *   - the core entry point quietly pulling an adapter into the module graph
 *
 * Needs no network and no credentials: the fixtures use the scripted client and a
 * local HTTP server. `npm install` of the local tarball runs offline.
 *
 *   npm run check:package
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function step(label, run) {
  process.stdout.write(`${label}\n`);
  try {
    const output = run();
    if (output && output.trim() !== "") {
      for (const line of output.trim().split("\n")) process.stdout.write(`  ${line}\n`);
    }
  } catch (error) {
    const detail = (error.stdout ?? "") + (error.stderr ?? "");
    for (const line of String(detail).trim().split("\n").slice(-15)) process.stdout.write(`  ${line}\n`);
    failures.push(`${label} failed`);
  }
}

function shell(command, args, options) {
  // npm is a .cmd shim on Windows; execute its JavaScript CLI through Node.
  if (command === "npm" && process.env["npm_execpath"] !== undefined) {
    args = [process.env["npm_execpath"], ...args];
    command = process.execPath;
  }
  return execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: "pipe" });
}

// ---------------------------------------------------------------------------
// 1. Build
// ---------------------------------------------------------------------------

step("building", () => shell("npm", ["run", "build"], { cwd: root }));

// ---------------------------------------------------------------------------
// 2. Pack
// ---------------------------------------------------------------------------

const packDir = mkdtempSync(join(tmpdir(), "agent-core-pack-"));
let tarball;

step("packing the tarball", () => {
  const output = shell("npm", ["pack", "--pack-destination", packDir, "--silent"], { cwd: root });
  const name = output.trim().split("\n").filter(Boolean).at(-1);
  tarball = join(packDir, name);
  return `tarball: ${name}`;
});

if (tarball === undefined) {
  console.error("\npackage check failed: no tarball was produced");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Inspect the tarball contents
// ---------------------------------------------------------------------------

step("inspecting the tarball contents", () => {
  const listing = shell("tar", ["-tzf", tarball], { cwd: packDir }).trim().split(/\r?\n/);

  const required = [
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/docs/integration.md",
    "package/examples/index.mjs",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/openai.js",
    "package/dist/openai.d.ts",
    "package/dist/faux.js",
    "package/dist/conformance.js",
  ];
  for (const file of required) {
    if (!listing.includes(file)) failures.push(`the tarball is missing ${file}`);
  }

  // Nothing from the development side should ship: tests, scripts, sources,
  // tsconfig, or a stray local env file.
  const unwanted = /^package\/(test|src|scripts)\/|^package\/(tsconfig.*\.json|vitest\.config\.ts|\.env.*|package-lock\.json)$/;
  for (const file of listing) {
    if (unwanted.test(file)) failures.push(`the tarball contains ${file}, which should not ship`);
  }

  return `${listing.length} files`;
});

// ---------------------------------------------------------------------------
// 4. Install into a throwaway consumer
// ---------------------------------------------------------------------------

const consumer = mkdtempSync(join(tmpdir(), "agent-core-consumer-"));

step("installing into a fresh project", () => {
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", version: "1.0.0", private: true, type: "module" }, null, 2),
  );
  shell("npm", ["install", "--silent", "--no-audit", "--no-fund", tarball], { cwd: consumer });

  const installed = JSON.parse(readFileSync(join(consumer, "node_modules/agent-core/package.json"), "utf8"));
  return `installed agent-core@${installed.version}, exports: ${Object.keys(installed.exports).join(", ")}`;
});

// ---------------------------------------------------------------------------
// 5. Run the consumer fixtures
// ---------------------------------------------------------------------------

const fixtures = join(root, "scripts/consumer");
cpSync(fixtures, consumer, { recursive: true });

for (const script of ["use-core.mjs", "use-openai.mjs", "third-party-adapter.mjs"]) {
  step(`running ${script}`, () => {
    const output = shell(process.execPath, [join(consumer, script)], { cwd: consumer });
    // The fixtures print their own progress lines; surface them.
    for (const line of output.trim().split("\n")) process.stdout.write(`${line}\n`);
    return "";
  });
}

// ---------------------------------------------------------------------------
// 6. Type declarations under a strict consumer
// ---------------------------------------------------------------------------

step("type-checking a TypeScript consumer", () => {
  // The package is Node-only, so its declarations refer to Node globals:
  // `AbortSignal`, `ReadableStream`, `fetch`. A TypeScript consumer on Node has
  // `@types/node` installed — every Node project that types `process` or
  // `console` does — so the fixture gets one too. Copying the repository's copy
  // keeps this offline and pins the same version.
  for (const typePackage of ["@types/node", "undici-types"]) {
    cpSync(join(root, "node_modules", typePackage), join(consumer, "node_modules", typePackage), {
      recursive: true,
    });
  }

  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          // Deliberately no "DOM": a Node library must not need browser libs.
          lib: ["ES2023"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          types: ["node"],
          strict: true,
          noEmit: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          // Not skipped: the published declarations must be clean on their own.
          skipLibCheck: false,
        },
        include: ["use-core.ts", "doc-surface.ts"],
      },
      null,
      2,
    ),
  );

  // Reuse the repo's TypeScript, so the check does not install anything.
  const tsc = join(root, "node_modules/typescript/bin/tsc");
  try {
    shell(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: consumer });
  } catch (error) {
    const detail = String((error.stdout ?? "") + (error.stderr ?? ""));
    failures.push(`a strict TypeScript consumer does not compile:\n${detail.trim()}`);
    return "see the compiler output above";
  }
  return "strict consumer compiles with skipLibCheck: false, no DOM lib";
});

// ---------------------------------------------------------------------------
// 7. The core entry point must not load an adapter
// ---------------------------------------------------------------------------

step("checking that the core entry point loads no adapter and no SDK", () => {
  // Poison the adapter files *and* the vendor SDK. If importing the core pulls
  // any of them in, the import throws and the failure names itself.
  //
  // The SDK is part of this check rather than a separate one because it is the
  // interesting case: `npm install` puts `openai` on disk no matter what, so
  // "the core has no dependency" is no longer true. "The core does not load it"
  // still is, and that is what an embedding agent actually pays for at startup.
  const dist = join(consumer, "node_modules/agent-core/dist");
  const poisoned = [
    join(dist, "openai.js"),
    join(dist, "providers/openai/index.js"),
    join(dist, "providers/faux/index.js"),
    join(consumer, "node_modules/openai/index.js"),
    join(consumer, "node_modules/openai/index.mjs"),
  ];
  const originals = new Map();

  for (const path of poisoned) {
    let original;
    try {
      original = readFileSync(path, "utf8");
    } catch {
      continue; // Not every variant of the SDK entry file exists.
    }
    originals.set(path, original);
    writeFileSync(path, 'throw new Error("a provider dependency was loaded by a core-only import");\n');
  }

  try {
    const output = shell(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const core = await import("agent-core");' +
          'if ("openaiClient" in core) { console.error("core exports openaiClient"); process.exit(1); }' +
          `console.log("core imported with providers poisoned, VERSION " + core.VERSION);`,
      ],
      { cwd: consumer },
    );
    return output.trim();
  } catch (error) {
    failures.push(
      `importing agent-core loaded a provider dependency: ${String(error.stderr ?? error).trim().split("\n")[0]}`,
    );
    return "";
  } finally {
    for (const [path, contents] of originals) writeFileSync(path, contents);
  }
});

// ---------------------------------------------------------------------------
// Wrap up
// ---------------------------------------------------------------------------

rmSync(packDir, { recursive: true, force: true });
rmSync(consumer, { recursive: true, force: true });

if (failures.length > 0) {
  console.error("\nPackage check failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\nPackage check passed: built, packed, installed, and consumed from outside the repository.");
