/**
 * Tool definitions, the registry that holds them, and the executor that turns a
 * model's `ToolCall` into a `ToolResultMessage`.
 *
 * The one rule this file enforces: **a tool failure is data, not an exception.**
 * Unknown tools, bad arguments, thrown errors and timeouts all come back as an
 * `isError` tool result whose text a model can read and act on. That is what
 * lets a run self-correct inside a single turn loop instead of dying and
 * handing the problem to the caller.
 *
 * What it deliberately does not do:
 *
 * - No output truncation. How much of a 2 MB file dump fits in the context
 *   window is a property of the model and the caller's budget, not of the tool
 *   layer. Callers trim in `onBeforeRequest`.
 * - No concurrency policy. `executeTool` runs one call; deciding whether a
 *   batch of calls may run in parallel belongs to the loop.
 * - No permissions. Approval flows need a UI and a human; both live above.
 */

import { toNormalizedError } from "./errors.js";
import { InvalidSchemaError, checkSchema, validate, type JSONSchema } from "./schema.js";
import type { ContentBlock, NormalizedError, ToolCall, ToolResult, ToolResultMessage } from "./types.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * What a tool implementation gets at call time.
 *
 * Deliberately tiny. A tool that needs the filesystem, a database or an HTTP
 * client receives it through a closure when the tool is defined, so nothing
 * ambient leaks into the core and two agents in one process cannot accidentally
 * share state through a tool context.
 */
export interface ToolContext {
  /** The call being executed. */
  callId: string;
  /** 1-based turn index within the current run. */
  turn: number;
  /**
   * Aborts when the run is cancelled. Long-running tools should pass this to
   * their I/O and return early rather than finishing work nobody will read.
   */
  signal?: AbortSignal;
  /**
   * Report partial output for a progress UI. Never reaches the model; it only
   * surfaces as `tool_update` events.
   */
  onUpdate?: (partial: string) => void;
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

/**
 * A tool the model can call.
 *
 * `A` is the argument type after validation — the shape the tool's `execute`
 * sees. It is not inferred from the schema (that would need a full type-level
 * JSON Schema interpreter); declare it with `defineTool<MyArgs>({ ... })` and let
 * the validator enforce it at runtime.
 */
export interface ToolDefinition<A = unknown> {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** Runs the tool. May throw; the executor converts failures into results. */
  execute: (args: A, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
  /**
   * Optional per-call deadline in milliseconds.
   *
   * No default on purpose: reading a file and running a test suite have no
   * sensible shared ceiling, and a wrong default produces failures that look
   * like hangs. Omit it and control cancellation through `ctx.signal`.
   */
  timeoutMs?: number;
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Define a tool, validating its shape at startup.
 *
 * Authoring mistakes (an empty description, a malformed name, an unsupported
 * schema keyword) surface here, when the agent starts, rather than on the first
 * call in front of a user.
 */
export function defineTool<A = unknown>(definition: ToolDefinition<A>): ToolDefinition<A> {
  if (!NAME_PATTERN.test(definition.name)) {
    throw new Error(
      `Invalid tool name "${definition.name}": use 1-64 characters of letters, digits, underscore or hyphen.`,
    );
  }
  if (definition.description.trim() === "") {
    throw new Error(`Tool "${definition.name}" needs a description; it is the model's only instruction.`);
  }
  if (definition.timeoutMs !== undefined && !(definition.timeoutMs > 0)) {
    throw new Error(`Tool "${definition.name}" has a non-positive timeoutMs.`);
  }
  // Check the schema's own structure once, here, so an unsupported keyword or a
  // broken pattern surfaces at startup instead of on some model's first call.
  try {
    checkSchema(definition.parameters);
  } catch (error) {
    if (error instanceof InvalidSchemaError) {
      throw new Error(`Tool "${definition.name}": ${error.message}`, { cause: error });
    }
    throw error;
  }
  return definition;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * A name-indexed set of tools.
 *
 * Instances are independent and hold no global state, so an agent can create
 * one per run. Duplicate names are rejected rather than last-one-wins: two
 * tools with the same name is always a bug, and silently preferring one makes
 * it a bug that only shows up in production.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition<never>>();

  constructor(tools: readonly ToolDefinition<never>[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: ToolDefinition<never>): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Duplicate tool name "${tool.name}".`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition<never> | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Every tool, in registration order. */
  list(): ToolDefinition<never>[] {
    return [...this.#tools.values()];
  }

  get size(): number {
    return this.#tools.size;
  }

  /**
   * The subset named by an allowlist, in the order given.
   *
   * Throws on an unknown name: a typo in a config file should fail at startup,
   * not quietly hand the model a smaller toolbox than the caller intended.
   */
  pick(names: readonly string[]): ToolDefinition<never>[] {
    return names.map((name) => {
      const tool = this.#tools.get(name);
      if (!tool) {
        throw new Error(`Unknown tool "${name}". Available: ${[...this.#tools.keys()].join(", ") || "none"}.`);
      }
      return tool;
    });
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** The outcome of one tool call. Never a thrown error. */
export interface ToolExecution {
  /** Always present: the message to append to the transcript. */
  message: ToolResultMessage;
  /** Present when the tool did not succeed. */
  error?: NormalizedError;
  /**
   * True when the run was cancelled. The loop discards the message rather than
   * feeding it to the model — telling a model "you were interrupted" invites it
   * to retry work the caller just cancelled.
   */
  aborted: boolean;
}

/** Cap on how much of a thrown error's text is fed back to the model. */
const MAX_ERROR_CHARS = 2_000;

/**
 * Run one tool call.
 *
 * Order of checks matters and is fixed: abort, then existence, then argument
 * validation, then execution. A model that hallucinates a tool name gets a
 * different message than one that hallucinates an argument.
 */
export async function executeTool(
  tool: ToolDefinition<never> | undefined,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolExecution> {
  if (ctx.signal?.aborted) {
    return abortedExecution(call, "The run was cancelled before this call started.");
  }

  if (!tool) {
    return failedExecution(
      call,
      toNormalizedError("invalidToolCall", `There is no tool named "${call.name}".`),
    );
  }

  const violations = validate(tool.parameters, call.args);
  if (violations.length > 0) {
    return failedExecution(
      call,
      toNormalizedError("invalidToolCall", invalidArgumentsMessage(tool.name, violations)),
    );
  }

  const startedAt = performance.now();

  try {
    const result = await runWithTimeout(tool, call, ctx);
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: result.content,
      isError: result.isError ?? false,
    };
    if (result.details !== undefined) message.details = result.details;

    if (message.isError) {
      return {
        aborted: false,
        message,
        error: toNormalizedError(
          "toolFailed",
          `Tool "${tool.name}" reported a failure after ${Math.round(performance.now() - startedAt)}ms.`,
        ),
      };
    }
    return { aborted: false, message };
  } catch (thrown) {
    if (isAbortError(thrown) || ctx.signal?.aborted) {
      return abortedExecution(call, `Tool "${tool.name}" was cancelled.`);
    }

    const error = classifyThrown(tool.name, thrown);
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: error.message }],
      isError: true,
    };
    return { aborted: false, message, error };
  }
}

async function runWithTimeout(
  tool: ToolDefinition<never>,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const execution = Promise.resolve().then(() =>
    (tool.execute as (args: unknown, ctx: ToolContext) => ToolResult | Promise<ToolResult>)(call.args, ctx),
  );

  if (tool.timeoutMs === undefined) return execution;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ToolTimeoutError(tool.name, tool.timeoutMs!));
    }, tool.timeoutMs);
  });

  try {
    return await Promise.race([execution, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class ToolTimeoutError extends Error {
  constructor(
    readonly toolName: string,
    readonly timeoutMs: number,
  ) {
    super(`Tool "${toolName}" exceeded its ${timeoutMs}ms timeout.`);
    this.name = "ToolTimeoutError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Map anything a tool throws onto the error taxonomy.
 *
 * The model sees a short, sanitised sentence. The original is kept in `cause`
 * for the caller's logs — a stack trace in the transcript is noise the model
 * cannot use and which costs tokens on every subsequent turn.
 */
function classifyThrown(toolName: string, thrown: unknown): NormalizedError {
  if (thrown instanceof ToolTimeoutError) {
    return toNormalizedError("toolFailed", thrown.message, { cause: thrown });
  }

  const raw = thrown instanceof Error ? thrown.message : String(thrown);
  const text = raw.length > MAX_ERROR_CHARS ? `${raw.slice(0, MAX_ERROR_CHARS)}…` : raw;

  return toNormalizedError("toolFailed", `Tool "${toolName}" failed: ${text || "no error message"}`, {
    cause: thrown,
  });
}

function invalidArgumentsMessage(
  toolName: string,
  violations: readonly { path: string; message: string }[],
): string {
  const lines = violations.map((v) => `- ${v.path || "(arguments)"}: ${v.message}`);
  return [
    `The arguments for tool "${toolName}" are invalid.`,
    ...lines,
    "Fix the arguments and call the tool again.",
  ].join("\n");
}

function failedExecution(call: ToolCall, error: NormalizedError): ToolExecution {
  return {
    aborted: false,
    error,
    message: errorResult(call, error.message),
  };
}

function abortedExecution(call: ToolCall, text: string): ToolExecution {
  return {
    aborted: true,
    error: toNormalizedError("aborted", text),
    message: errorResult(call, text),
  };
}

function errorResult(call: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** Wrap a string as a successful tool result. */
export function textResult(text: string, details?: unknown): ToolResult {
  const content: ContentBlock[] = [{ type: "text", text }];
  return details === undefined ? { content } : { content, details };
}

/** Wrap a structured value as pretty-printed JSON, with the value kept for the UI. */
export function jsonResult(value: unknown, indent = 2): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, indent) }], details: value };
}
