import type { Message } from "../core/messages.js";

// ---------------------------------------------------------------------------
// Transcript validation
// ---------------------------------------------------------------------------

/** A transcript problem that would make the provider reject the request. */
export interface TranscriptProblem {
  /**
   * `unanswered`: an assistant tool call with no tool result after it.
   * `orphan`: a tool result whose call is not in the transcript.
   */
  kind: "unanswered" | "orphan";
  /** Index of the offending message. */
  index: number;
  /** The call id involved, for finding it in a debugger. */
  callId: string;
}

/**
 * Find tool calls and results that do not pair up.
 *
 * The provider rejects such a transcript, usually with a message about roles
 * that does not name the offending message. Since trimming in `onBeforeRequest`
 * is exactly where a pairing gets broken — drop an assistant message, keep its
 * results, or vice versa — the loop runs this check before every request and
 * fails with a message that points at the problem instead.
 *
 * `callId` is the assistant's call id for `unanswered`, and the result's
 * `toolCallId` for `orphan`.
 */
export function findTranscriptProblems(messages: readonly Message[]): TranscriptProblem[] {
  const problems: TranscriptProblem[] = [];
  const knownCalls = new Set<string>();

  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls) {
        knownCalls.add(call.id);
        // Look ahead over the results that immediately follow.
        const answeredBy = new Set<string>();
        for (let next = index + 1; next < messages.length; next += 1) {
          const candidate = messages[next];
          if (candidate?.role !== "toolResult") break;
          answeredBy.add(candidate.toolCallId);
        }
        if (!answeredBy.has(call.id)) {
          problems.push({ kind: "unanswered", index, callId: call.id });
        }
      }
    } else if (message.role === "toolResult" && !knownCalls.has(message.toolCallId)) {
      problems.push({ kind: "orphan", index, callId: message.toolCallId });
    }
  }

  return problems;
}

/** Render `findTranscriptProblems` output as one line a caller can act on. */
export function describeTranscriptProblems(problems: readonly TranscriptProblem[]): string {
  const parts = problems.map((problem) =>
    problem.kind === "unanswered"
      ? `message ${problem.index} has a tool call (${problem.callId}) with no result after it`
      : `message ${problem.index} is a tool result for an unknown call (${problem.callId})`,
  );
  return `The transcript is not valid for a model request: ${parts.join("; ")}.`;
}
