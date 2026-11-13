/**
 * Error normalisation helpers.
 *
 * The taxonomy itself lives in `types.ts` next to the other shared shapes. What
 * lives here is the one opinion the core holds about it: which kinds are worth
 * retrying. Adapters use this to fill in `NormalizedError.retryable` without
 * each of them re-deriving the same table, and callers can use it to decide
 * whether a failure belongs in a retry loop.
 */

import type { ErrorKind, NormalizedError } from "./types.js";

/**
 * Default retry stance per error kind.
 *
 * `aborted` and `invalidToolCall` are not "retryable" in the transport sense:
 * the first is the caller's own decision, the second is handed back to the
 * model as a tool result so *it* can retry with better arguments.
 */
export const DEFAULT_RETRYABLE: Readonly<Record<ErrorKind, boolean>> = Object.freeze({
  auth: false,
  rateLimit: true,
  overloaded: true,
  invalidRequest: false,
  contextOverflow: false,
  network: true,
  aborted: false,
  invalidToolCall: false,
  toolFailed: false,
  provider: false,
  unknown: false,
});

/** Build a `NormalizedError`, filling `retryable` from the kind when not given. */
export function toNormalizedError(
  kind: ErrorKind,
  message: string,
  extra: Omit<NormalizedError, "kind" | "message" | "retryable"> & { retryable?: boolean } = {},
): NormalizedError {
  const { retryable, ...rest } = extra;
  const error: NormalizedError = {
    kind,
    message,
    retryable: retryable ?? DEFAULT_RETRYABLE[kind],
  };
  // Assigned one by one rather than spread so that `exactOptionalPropertyTypes`
  // keeps absent keys absent instead of present-and-undefined.
  if (rest.status !== undefined) error.status = rest.status;
  if (rest.provider !== undefined) error.provider = rest.provider;
  if (rest.retryAfterSeconds !== undefined) error.retryAfterSeconds = rest.retryAfterSeconds;
  if (rest.cause !== undefined) error.cause = rest.cause;
  return error;
}
