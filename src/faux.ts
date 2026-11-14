/**
 * `agent-framework/faux` — a scripted `LLMClient` for tests and examples.
 *
 * Deliberately its own entry point and not part of the core: nothing in the
 * runtime needs it, and a production bundle should not carry a test double.
 */

export { fauxClient, type FauxClient, type FauxOptions, type FauxTurn } from "./providers/faux/index.js";
