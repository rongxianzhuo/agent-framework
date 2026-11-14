// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Token accounting for one response or one run.
 *
 * Cache fields are separate rather than folded into `inputTokens` so an
 * embedding agent can report real cost: cached input is typically an order of
 * magnitude cheaper. `totalTokens` is stored rather than computed because
 * providers disagree on whether it includes cache reads.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Estimated spend in USD, when the adapter knows the model's price. */
  costUsd?: number;
}

export const EMPTY_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
});

/** Sum two usage records. `costUsd` is summed only when both sides have one. */
export function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (b === undefined) return a;
  const total: Usage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
  if (a.costUsd !== undefined && b.costUsd !== undefined) total.costUsd = a.costUsd + b.costUsd;
  else if (a.costUsd !== undefined) total.costUsd = a.costUsd;
  else if (b.costUsd !== undefined) total.costUsd = b.costUsd;
  return total;
}
