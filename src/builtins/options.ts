/** Options shared by the built-in file-reading tools. */
export interface ReadToolOptions {
  /** Override the tool's default name. */
  name?: string;
  /** Optional per-call timeout; cancellation uses the existing tool executor. */
  timeoutMs?: number;
}

/** Both readers require a fully qualified absolute file path. */
export interface ReadPathArgs {
  path: string;
}
