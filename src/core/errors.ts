// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * How an error should be handled, independent of who threw it.
 *
 * Providers express the same failures with wildly different shapes (HTTP
 * status, error codes, English message text). Adapters map them into this
 * taxonomy once, and everything above can make decisions without parsing
 * strings.
 */
export type ErrorKind =
  /** Bad or missing credentials. Not retryable. */
  | "auth"
  /** Provider rate limit. Retryable after a delay. */
  | "rateLimit"
  /** Provider is overloaded or returned 5xx. Retryable. */
  | "overloaded"
  /** The request itself was malformed. Not retryable. */
  | "invalidRequest"
  /** Prompt plus history exceeds the model's context window. Needs trimming. */
  | "contextOverflow"
  /** Connection failure, DNS error, reset. Retryable. */
  | "network"
  /** The caller's `AbortSignal` fired. Not an error in the usual sense. */
  | "aborted"
  /** Tool arguments did not match the tool's schema. Fed back to the model. */
  | "invalidToolCall"
  /** A tool threw or returned a failure. Fed back to the model. */
  | "toolFailed"
  /** A caller-supplied hook threw. Ends the run, since a broken guard is not a guard. */
  | "hook"
  /** Unclassified provider failure. */
  | "provider"
  /** Anything else. */
  | "unknown";

/** A provider or tool failure, normalised so callers can act on it. */
export interface NormalizedError {
  kind: ErrorKind;
  /** Human-readable message, safe to show in a log or feed back to the model. */
  message: string;
  /**
   * Whether retrying the same request could succeed. Derived from `kind`, but
   * stored explicitly because adapters occasionally know better (a specific
   * 429 with a long `retry-after`, for instance).
   */
  retryable: boolean;
  /** HTTP status when one applies. */
  status?: number;
  /** Provider name, when known. */
  provider?: string;
  /** Seconds the provider asked us to wait, from `retry-after` or equivalent. */
  retryAfterSeconds?: number;
  /** Original error, kept for logging. Never sent to the model. */
  cause?: unknown;
}

/**
 * Error normalisation helpers.
 *
 * The taxonomy and helpers live together here. The core defines which kinds
 * are worth retrying. Adapters use this to fill in `NormalizedError.retryable` without
 * each of them re-deriving the same table, and callers can use it to decide
 * whether a failure belongs in a retry loop.
 */


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
  hook: false,
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

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Recognise something that is already in the normalised shape.
 *
 * Adapters throw these directly; the loop needs to tell them apart from an
 * unexpected JavaScript error so it does not bury a `rateLimit` under `unknown`.
 */
export function isNormalizedError(value: unknown): value is NormalizedError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    "retryable" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

/** Convert anything thrown by a client into a `NormalizedError`. */
export function normalizeThrown(thrown: unknown, provider?: string): NormalizedError {
  if (isNormalizedError(thrown)) {
    return thrown.provider !== undefined || provider === undefined
      ? thrown
      : { ...thrown, provider };
  }
  if (thrown instanceof Error && (thrown.name === "AbortError" || thrown.name === "TimeoutError")) {
    return toNormalizedError("aborted", thrown.message || "The request was aborted.", {
      cause: thrown,
      ...(provider === undefined ? {} : { provider }),
    });
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return toNormalizedError("unknown", message || "Unknown provider failure.", {
    cause: thrown,
    ...(provider === undefined ? {} : { provider }),
  });
}
