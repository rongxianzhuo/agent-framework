/**
 * A conformance suite for adapters, including ones written outside this project.
 *
 * The point is that "implements LLMClient" is a testable claim. Every adapter is
 * asked the same questions — does a plain reply come back with usage, are tool
 * arguments assembled and parsed, is the transcript with a tool result accepted,
 * does an abort actually stop it — and gets a pass/fail list back.
 *
 * Deliberately not a test framework: results are plain data. Callers wrap them in
 * whatever they already use. That keeps this package free of a test-runner
 * dependency and lets an adapter author run conformance from a script.
 *
 * Each check makes one model call with no output-token cap by default, on the
 * theory that a check which fails for budget reasons teaches nothing. That makes
 * the suite's cost the model's business rather than yours: pass
 * `maxOutputTokens` when running against an expensive model, or `only` to run a
 * subset.
 */

import { run } from "../loop.js";
import { defineTool, textResult } from "../tools.js";
import type { LLMClient } from "../client.js";
import type { JSONSchema } from "../schema.js";
import type { Message } from "../types.js";

export type ConformanceCheck =
  | "text"
  | "system"
  | "tool-call"
  | "tool-result"
  | "abort"
  | "usage";

export interface ConformanceOptions {
  /** Model id the adapter understands. Required: there is no sensible default. */
  model: string;
  /** Extra request parameters, e.g. an API key through `providerOptions`. */
  providerOptions?: Record<string, unknown>;
  /**
   * Cap on output tokens per check. Unset by default: no cap is sent at all.
   *
   * Capping was the default once, to keep the suite cheap, and it made the
   * checks less reliable than the cost saved. A thinking model spends the same
   * budget on reasoning before it writes anything, so a small cap truncates the
   * tool-call JSON mid-object; the `abort` check asks for a long generation and
   * a cap contradicts it. Set a value when running against an expensive model.
   */
  maxOutputTokens?: number;
  /** Run only these checks. Defaults to all of them. */
  only?: readonly ConformanceCheck[];
  /** Skip these checks, e.g. `["abort"]` for a client without cancellation. */
  skip?: readonly ConformanceCheck[];
  /** Per-check deadline. Defaults to 60s. */
  timeoutMs?: number;
  /**
   * How long an abort may take before it counts as ignored. Defaults to 2000ms.
   *
   * Generous on purpose: a real provider has a socket to tear down. The point is
   * to catch an adapter that never looks at the signal, not to grade latency.
   */
  abortGraceMs?: number;
  /**
   * Name of the probe tool used by the tool checks. Change it only if the
   * adapter has rules about tool names.
   */
  toolName?: string;
}

export interface ConformanceResult {
  check: ConformanceCheck;
  ok: boolean;
  /** One line: what was observed, or what was expected. */
  detail: string;
  durationMs: number;
}

/** Probe tool schema: one required string, nothing else. */
const PROBE_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    value: { type: "string", description: "A short label to echo back." },
  },
  required: ["value"],
  additionalProperties: false,
};

/**
 * Run the suite.
 *
 * Never throws for a check failure: a failing check is a result with `ok: false`
 * and a detail line. A thrown error from this function means the options were
 * unusable.
 */
export async function runConformance(
  client: LLMClient,
  options: ConformanceOptions,
): Promise<ConformanceResult[]> {
  if (options.model.trim() === "") {
    throw new Error("runConformance requires a model id.");
  }

  const toolName = options.toolName ?? "conformance_probe";
  const selected = selectChecks(options);
  const results: ConformanceResult[] = [];

  for (const check of selected) {
    const startedAt = Date.now();
    try {
      const detail = await withTimeout(
        CHECKS[check](client, options, toolName),
        options.timeoutMs ?? 60_000,
        check,
      );
      results.push({ check, ok: true, detail, durationMs: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ check, ok: false, detail: message, durationMs: Date.now() - startedAt });
    }
  }

  return results;
}

/** Convenience predicate for a suite result set. */
export function allPassed(results: readonly ConformanceResult[]): boolean {
  return results.every((result) => result.ok);
}

/** One-line summary, for a CLI or a log. */
export function formatResults(results: readonly ConformanceResult[]): string {
  return results
    .map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.check} (${r.durationMs}ms): ${r.detail}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

type Check = (client: LLMClient, options: ConformanceOptions, toolName: string) => Promise<string>;

const CHECKS: Record<ConformanceCheck, Check> = {
  /**
   * The floor: a plain prompt returns text, a stop reason, and usage. An adapter
   * that fails this is not usable at all.
   */
  async text(client, options) {
    const result = await run({
      client,
      model: options.model,
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: ready" }] }],
      ...requestOptions(options),
    });

    if (result.stopReason !== "completed") {
      throw new Error(`expected stopReason "completed", got "${result.stopReason}" (${describe(result.error)})`);
    }
    const assistant = result.messages.at(-1);
    if (assistant?.role !== "assistant") throw new Error("the run produced no assistant message");

    const text = assistant.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();

    if (text === "") throw new Error("the assistant message contains no text block");
    return `${text.length} chars of text, stopReason "${assistant.stopReason}"`;
  },

  /** A leading system message must be accepted rather than rejected or dropped. */
  async system(client, options) {
    const result = await run({
      client,
      model: options.model,
      messages: [
        { role: "system", content: [{ type: "text", text: "You are a terse assistant. One word answers only." }] },
        { role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] },
      ],
      ...requestOptions(options),
    });

    if (result.stopReason !== "completed") {
      throw new Error(`expected stopReason "completed", got "${result.stopReason}" (${describe(result.error)})`);
    }
    return "system message accepted";
  },

  /** Tool arguments must arrive assembled and parsed, not as a JSON string. */
  async "tool-call"(client, options, toolName) {
    const seen: unknown[] = [];
    const probe = defineTool<{ value: string }>({
      name: toolName,
      description: `Echo a label back. Use this whenever the user asks you to call ${toolName}.`,
      parameters: PROBE_PARAMETERS,
      execute: (args) => {
        seen.push(args);
        return textResult(`probe received ${args.value}`);
      },
    });

    const result = await run({
      client,
      model: options.model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Call the tool ${toolName} exactly once with value "conformance", then stop. Do not answer in prose.`,
            },
          ],
        },
      ],
      tools: [probe],
      maxTurns: 1,
      ...requestOptions(options),
    });

    if (result.stopReason === "error") throw new Error(describe(result.error));

    const assistant = result.messages.find((m) => m.role === "assistant");
    if (assistant?.role !== "assistant") throw new Error("the run produced no assistant message");
    const call = assistant.toolCalls.find((c) => c.name === toolName);
    if (call === undefined) {
      throw new Error(
        `expected a tool call to "${toolName}", got ${assistant.toolCalls.length} call(s). A model that ignores tools cannot be validated here.`,
      );
    }
    if (call.id === undefined || call.id === "") throw new Error("the tool call has no id");
    if (typeof call.args !== "object" || call.args === null) {
      throw new Error(`tool arguments were not parsed into an object: ${String(call.args)}`);
    }

    const args = call.args as Record<string, unknown>;
    if (args["value"] !== "conformance") {
      throw new Error(`expected args.value to be "conformance", got ${JSON.stringify(args["value"])}`);
    }
    // The loop executes tools within the turn, so a passing call must have
    // reached the tool implementation with the same arguments.
    if (seen.length === 0) throw new Error("the tool call was assembled but never executed");
    if (JSON.stringify(seen[0]) !== JSON.stringify(args)) {
      throw new Error(`the executed arguments differ from the assembled ones: ${JSON.stringify(seen[0])}`);
    }
    return `call ${call.id} assembled and executed with args ${JSON.stringify(args)}`;
  },

  /** A transcript that already contains a tool call and its result must be accepted. */
  async "tool-result"(client, options, toolName) {
    const transcript: Message[] = [
      { role: "user", content: [{ type: "text", text: `What did ${toolName} return? One word.` }] },
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "conformance_call_1", name: toolName, args: { value: "conformance" } }],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "conformance_call_1",
        toolName,
        content: [{ type: "text", text: "probe received conformance" }],
        isError: false,
      },
    ];

    const probe = defineTool({
      name: toolName,
      description: "Unused here; the tool result is already in the transcript.",
      parameters: PROBE_PARAMETERS,
      execute: () => textResult(""),
    });

    const result = await run({
      client,
      model: options.model,
      messages: transcript,
      tools: [probe],
      maxTurns: 1,
      ...requestOptions(options),
    });

    if (result.stopReason === "error") {
      throw new Error(`the transcript with a tool result was rejected: ${describe(result.error)}`);
    }
    const assistant = result.messages.at(-1);
    if (assistant?.role !== "assistant") throw new Error("the run produced no assistant message");
    const text = assistant.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    if (text === "") throw new Error("no text in the reply that followed a tool result");
    return `tool result accepted, reply: "${truncate(text)}"`;
  },

  /** Cancellation must interrupt promptly instead of running to completion. */
  async abort(client, options) {
    const controller = new AbortController();
    const abortAfterMs = 300;
    const graceMs = options.abortGraceMs ?? 2_000;
    const timer = setTimeout(() => controller.abort(), abortAfterMs);

    try {
      const startedAt = Date.now();
      const result = await run({
        client,
        model: options.model,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Count slowly from 1 to 200, one number per line." }],
          },
        ],
        signal: controller.signal,
        ...requestOptions(options),
      });
      const elapsed = Date.now() - startedAt;

      if (result.stopReason === "completed") {
        // A short reply can legitimately finish first. That is not a failure of
        // the adapter, so say so rather than claiming an abort bug.
        return `the reply completed in ${elapsed}ms before the abort; not conclusive`;
      }
      if (result.stopReason !== "aborted") {
        throw new Error(`expected "aborted", got "${result.stopReason}" (${describe(result.error)})`);
      }
      if (elapsed > abortAfterMs + graceMs) {
        throw new Error(
          `the run only reported "aborted" after ${elapsed}ms; the abort was raised at ${abortAfterMs}ms, so the adapter is probably ignoring the signal and finishing the response anyway`,
        );
      }
      return `aborted ${elapsed - abortAfterMs}ms after the signal`;
    } finally {
      clearTimeout(timer);
    }
  },

  /** Usage must be present and self-consistent; cost reporting depends on it. */
  async usage(client, options) {
    const result = await run({
      client,
      model: options.model,
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: metered" }] }],
      ...requestOptions(options),
    });

    if (result.stopReason === "error") throw new Error(describe(result.error));

    const assistant = result.messages.find((m) => m.role === "assistant");
    if (assistant?.role !== "assistant") throw new Error("the run produced no assistant message");
    if (assistant.usage === undefined) {
      throw new Error("the assistant message carries no usage; token accounting will be unusable");
    }

    const fields: (keyof typeof assistant.usage)[] = [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "totalTokens",
    ];
    for (const field of fields) {
      const value = assistant.usage[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`usage.${field} is ${String(value)}; expected a finite non-negative number`);
      }
    }
    if (assistant.usage.totalTokens <= 0) {
      throw new Error("usage.totalTokens is 0; the adapter is probably not reading the provider's counters");
    }
    if (assistant.usage.outputTokens <= 0) {
      throw new Error("usage.outputTokens is 0 for a non-empty reply");
    }
    return `total ${assistant.usage.totalTokens} tokens (${assistant.usage.inputTokens} in, ${assistant.usage.outputTokens} out)`;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function selectChecks(options: ConformanceOptions): ConformanceCheck[] {
  const all = Object.keys(CHECKS) as ConformanceCheck[];
  const only = options.only === undefined ? all : all.filter((check) => options.only!.includes(check));
  const skip = new Set(options.skip ?? []);
  return only.filter((check) => !skip.has(check));
}

function requestOptions(options: ConformanceOptions): {
  maxOutputTokens?: number;
  providerOptions?: Record<string, unknown>;
} {
  const request: { maxOutputTokens?: number; providerOptions?: Record<string, unknown> } = {};
  // No default cap: see ConformanceOptions.maxOutputTokens. An explicit value
  // still passes straight through.
  if (options.maxOutputTokens !== undefined) request.maxOutputTokens = options.maxOutputTokens;
  if (options.providerOptions !== undefined) request.providerOptions = options.providerOptions;
  return request;
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`check "${label}" did not finish within ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describe(error: { kind?: string; message?: string } | undefined): string {
  if (error === undefined) return "no error recorded";
  return `${error.kind ?? "unknown"}: ${error.message ?? "no message"}`;
}

function truncate(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
