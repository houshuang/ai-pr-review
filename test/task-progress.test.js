import { test } from "node:test";
import assert from "node:assert/strict";
import { withTaskProgress } from "../src/task-progress.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("silent work emits elapsed heartbeats and source activity without exposing content", async () => {
  const messages = [];
  const result = await withTaskProgress(
    "Repository research",
    async (activity) => {
      await delay(25);
      activity({ type: "command-started", command: "secret source content" });
      activity({ type: "command-completed" });
      await delay(25);
      return "notes";
    },
    { report: (message) => messages.push(message), intervalMs: 10 },
  );
  assert.equal(result, "notes");
  assert.match(messages[0], /started/);
  assert(messages.some((message) => /Waiting for Codex activity/.test(message)));
  assert(messages.some((message) => /1\/1 source commands finished/.test(message)));
  assert.match(messages.at(-1), /completed/);
  assert(!messages.join("\n").includes("secret"));
  const count = messages.length;
  await delay(25);
  assert.equal(messages.length, count);
});
test("failure stops progress timers and preserves the failure", async () => {
  const messages = [];
  const failure = new Error("CLI unavailable");
  await assert.rejects(
    withTaskProgress(
      "Writer",
      async () => {
        throw failure;
      },
      { report: (message) => messages.push(message), intervalMs: 5 },
    ),
    (error) => error === failure,
  );
  assert.match(messages.at(-1), /failed .*CLI unavailable/);
  await delay(20);
  assert.equal(messages.length, 2);
});
