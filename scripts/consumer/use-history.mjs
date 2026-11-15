// Run in the disposable installed-package consumer directory.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Agent } from "agent-framework";
import { fauxClient } from "agent-framework/faux";

const historyFile = resolve("history-fixture.json");
const seed = [{ role: "user", content: [{ type: "text", text: "Earlier question" }] },
  { role: "assistant", content: [{ type: "text", text: "Earlier answer" }], toolCalls: [], stopReason: "stop" }];
await writeFile(historyFile, JSON.stringify(seed));
const agent = new Agent({
  client: fauxClient({ turns: [{ text: "New answer" }] }), model: "test",
  system: "Never archive this prompt.", historyFile,
});
assert.equal(agent.messages.length, 3);
assert.equal((await agent.run("New question")).stopReason, "completed");
const archive = JSON.parse(await readFile(historyFile, "utf8"));
assert.equal(archive.length, 4);
assert.ok(archive.every(message => message.role !== "system"));
const restored = new Agent({ client: fauxClient({ turns: [] }), model: "test", historyFile });
assert.deepEqual(restored.messages.map(({ role, content }) => ({ role, content })),
  archive.map(({ role, content }) => ({ role, content })));
assert.equal(restored.messages.at(-1).stopReason, "stop");
assert.ok(archive.every(message => Object.keys(message).every(key =>
  ["role", "content", "toolCalls", "toolCallId", "toolName"].includes(key))));
await writeFile(historyFile, "invalid JSON");
assert.throws(() => new Agent({ client: fauxClient({ turns: [] }), model: "test", historyFile }), SyntaxError);
console.log("  history consumer: passed");
