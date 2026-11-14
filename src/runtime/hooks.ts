/**
 * Hooks: the three places an embedding agent gets to intervene in a run.
 *
 * The core stays policy-free — it does not know how much context a model can
 * afford, whether a tool is allowed to touch the filesystem, or whether a file
 * path in a result has to be hidden from the user. Those are all decisions a
 * caller makes, and each one needs to happen at a specific point in the loop.
 *
 *   onBeforeRequest  — rewrite the request just before it is sent. Context
 *                      trimming, injecting a reminder, swapping the model.
 *   onToolCall       — allow, deny, or answer from cache, before the tool runs.
 *                      This is where permission prompts live.
 *   onToolResult     — rewrite a result after the tool ran. Truncation,
 *                      redaction, reformatting for a UI.
 *
 * Every hook is optional and every hook defaults to "change nothing". Each can
 * be given as a single function or an array; arrays run in order.
 *
 * Chaining rules differ by kind, because the right answer differs:
 *
 * - `onBeforeRequest` and `onToolResult` **chain**: the second hook sees the
 *   first one's output. Trimming and redacting are both transformations, and two
 *   of them composed is what callers expect.
 * - `onToolCall` **short-circuits**: the first hook that returns a decision wins.
 *   A permission guard must not be overridable by a later hook that means to
 *   allow, so "deny" is final once said.
 *
 * A hook that throws fails the run with `kind: "hook"`. It does not fall through
 * and it does not fall back to "allowed": a guard that crashes is not a guard,
 * and silently proceeding after one is the worst outcome available.
 */

import { toNormalizedError, type NormalizedError } from "../core/errors.js";
import { toResultMessage } from "../tools/results.js";
import type { LLMRequest } from "../core/client.js";
import type { ToolDefinition } from "../tools/definition.js";
import type { ToolExecution } from "../tools/execute.js";
import { copyMessages, type Message, type ToolCall, type ToolResult } from "../core/messages.js";

// ---------------------------------------------------------------------------
// Hook signatures
// ---------------------------------------------------------------------------

export interface BeforeRequestContext {
  /** 1-based turn index within the run. */
  turn: number;
  /**
   * The request the loop is about to send: a snapshot of the transcript, the
   * tool specs, and the sampling parameters. Message data is detached from the
   * stored history; opaque tool-result details remain caller-owned references.
   */
  request: LLMRequest;
  signal: AbortSignal | undefined;
}

/**
 * Explicit request replacement. Only messages are persisted; model, tools and
 * generation settings still apply to this request only.
 */
export interface BeforeRequestUpdate {
  request: LLMRequest;
  /** Replace stored history with these messages after the full hook chain validates. */
  replaceHistory?: boolean;
}

export type BeforeRequestResult = LLMRequest | BeforeRequestUpdate | void;

/**
 * Return a request (temporary), { request, replaceHistory: true } (persistent
 * messages), or nothing. In-place message edits are temporary by default too.
 *
 * Returning a partial object is not supported on purpose: the request is a
 * small, flat structure, and `{ ...request, messages: trimmed }` says exactly
 * what changed.
 */
export type BeforeRequestHook = (
  context: BeforeRequestContext,
) => BeforeRequestResult | Promise<BeforeRequestResult>;

export interface ToolCallContext {
  turn: number;
  /** The call the model asked for, with arguments already parsed. */
  call: ToolCall;
  /**
   * The definition, or `undefined` when the model named a tool that was never
   * offered. A hook that inspects the definition must handle both.
   */
  tool: ToolDefinition<never> | undefined;
  signal: AbortSignal | undefined;
}

/**
 * What a `onToolCall` hook decides.
 *
 * - `undefined` / nothing: no opinion, continue to the next hook or execute.
 * - `{ deny }`: do not run the tool. The message becomes an `isError` tool
 *   result, so the model reads the refusal and can try something else. This is
 *   data, not an exception: a run that is told "no" does not die, it changes
 *   plan. Use it for permissions, budget limits, and cost caps.
 * - `{ result }`: do not run the tool, and use this result instead. For caching,
 *   stubbing in tests, and short-circuiting a tool whose answer is already known.
 */
export type ToolCallDecision =
  | void
  | undefined
  | { deny: string; details?: unknown }
  | { result: ToolResult };

export type ToolCallHook = (
  context: ToolCallContext,
) => ToolCallDecision | Promise<ToolCallDecision>;

export interface ToolResultContext {
  turn: number;
  call: ToolCall;
  /** The result as the tool produced it. */
  result: ToolResult;
  /** Wall-clock time the tool took, before any rewriting. */
  durationMs: number;
  /** Present when the tool failed; absent for hooks that short-circuited it. */
  error: NormalizedError | undefined;
  signal: AbortSignal | undefined;
}

/**
 * Return a replacement result, or nothing to leave it unchanged.
 *
 * Rewriting `isError` is allowed but rarely right: a hook that hides a failure
 * removes the signal the model needs to correct course.
 */
export type ToolResultHook = (
  context: ToolResultContext,
) => ToolResult | void | undefined | Promise<ToolResult | void | undefined>;

/** All hooks for a run. Omit it, or omit any member, to change nothing. */
export interface RunHooks {
  onBeforeRequest?: BeforeRequestHook | readonly BeforeRequestHook[];
  onToolCall?: ToolCallHook | readonly ToolCallHook[];
  onToolResult?: ToolResultHook | readonly ToolResultHook[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A hook threw. Carried out of the loop as a `hook` error rather than swallowed. */
export class HookError extends Error {
  constructor(
    readonly hook: "onBeforeRequest" | "onToolCall" | "onToolResult",
    override readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`The ${hook} hook threw: ${detail}`);
    this.name = "HookError";
  }

  toNormalized(): NormalizedError {
    return toNormalizedError("hook", this.message, { cause: this.cause });
  }
}

// ---------------------------------------------------------------------------
// The resolver the loop uses
// ---------------------------------------------------------------------------

/** Hooks normalised to arrays, with the chaining rules applied. */
export interface ResolvedHooks {
  /** Run `onBeforeRequest` in order and return the request to send. */
  beforeRequest(
    context: BeforeRequestContext,
    onReplaceHistory?: (messages: Message[]) => void,
  ): Promise<LLMRequest>;
  /** Run `onToolCall` until one returns a decision. */
  toolCall(context: ToolCallContext): Promise<ToolCallDecision>;
  /** Run `onToolResult` in order. Returns the execution with the result applied. */
  toolResult(context: ToolResultContext): Promise<ToolResult>;
}

/** True when a hooks object was given and has at least one hook. */
export function hasHooks(hooks: RunHooks | undefined): boolean {
  return (
    hooks !== undefined &&
    (hooks.onBeforeRequest !== undefined ||
      hooks.onToolCall !== undefined ||
      hooks.onToolResult !== undefined)
  );
}

export function resolveHooks(hooks: RunHooks | undefined): ResolvedHooks {
  if (!hooks) return NO_HOOKS;

  const before = toArray(hooks.onBeforeRequest);
  const call = toArray(hooks.onToolCall);
  const after = toArray(hooks.onToolResult);

  return {
    async beforeRequest(context, onReplaceHistory) {
      let request = context.request;
      for (const hook of before) {
        try {
          const next = await hook({ ...context, request });
          if (next === undefined) continue;
          if ("request" in next) {
            request = next.request;
            if (next.replaceHistory === true) {
              // Capture here so later temporary hooks cannot change this snapshot.
              onReplaceHistory?.(copyMessages(request.messages));
            }
          } else {
            request = next;
          }
        } catch (thrown) {
          throw new HookError("onBeforeRequest", thrown);
        }
      }
      return request;
    },

    async toolCall(context) {
      for (const hook of call) {
        let decision: ToolCallDecision;
        try {
          decision = await hook(context);
        } catch (thrown) {
          throw new HookError("onToolCall", thrown);
        }
        if (decision !== undefined) return decision;
      }
      return undefined;
    },

    async toolResult(context) {
      let result = context.result;
      for (const hook of after) {
        let next: ToolResult | void | undefined;
        try {
          next = await hook({ ...context, result });
        } catch (thrown) {
          throw new HookError("onToolResult", thrown);
        }
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

const NO_HOOKS: ResolvedHooks = {
  async beforeRequest(context) {
    return context.request;
  },
  async toolCall() {
    return undefined;
  },
  async toolResult(context) {
    return context.result;
  },
};

function toArray<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

// ---------------------------------------------------------------------------
// Helpers a hook author needs
// ---------------------------------------------------------------------------

/**
 * Apply `onToolResult` to an execution, or pass it through untouched.
 *
 * Interrupted executions are never rewritten: their message is discarded rather
 * than fed back, so there is nothing for a hook to usefully do with it. Denials
 * and cached results do go through, since they are ordinary results from the
 * model's point of view.
 */
export async function applyResultHooks(
  execution: ToolExecution,
  call: ToolCall,
  turn: number,
  hooks: ResolvedHooks,
  signal: AbortSignal | undefined,
): Promise<ToolExecution> {
  if (execution.aborted) return execution;

  const current: ToolResult = {
    content: execution.message.content,
    isError: execution.message.isError,
    ...(execution.message.details !== undefined ? { details: execution.message.details } : {}),
  };

  const rewritten = await hooks.toolResult({
    turn,
    call,
    result: current,
    durationMs: execution.durationMs,
    error: execution.error,
    signal,
  });

  // Rebuilt unconditionally rather than only when the hook returned a new
  // object: a hook that mutated `result` in place and returned nothing is doing
  // the same thing, and must not have its work silently dropped.
  const message = toResultMessage(call, rewritten);
  const next: ToolExecution = { aborted: false, message, durationMs: execution.durationMs };
  if (execution.error !== undefined) next.error = execution.error;
  return next;
}

/**
 * A result to feed back when a hook denies a call.
 *
 * No `error` is attached: a refusal is a decision the caller made, not a fault.
 * It still arrives as `isError: true` so the model treats it as "that did not
 * work, try something else" rather than as a result to build on.
 */
export function deniedExecution(call: ToolCall, reason: string, details?: unknown): ToolExecution {
  const result: ToolResult = {
    content: [{ type: "text", text: reason }],
    isError: true,
  };
  if (details !== undefined) result.details = details;
  return { aborted: false, message: toResultMessage(call, result), durationMs: 0 };
}
