import type { ToolDefinition } from "./definition.js";

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
