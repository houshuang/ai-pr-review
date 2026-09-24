import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexEvents } from "../src/ai-provider.js";
import { looksLikeBranchName } from "../src/resolve-branch.js";

test("Codex --json events yield summed usage and the terminating error", () => {
  const ok = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":3}}',
  ].join("\n");
  assert.deepEqual(parseCodexEvents(ok), {
    usage: { input: 110, cachedInput: 40, output: 10, reasoningOutput: 0 },
    failure: null,
  });

  const failed = [
    '{"type":"item.completed","item":{"type":"error","message":"model metadata warning"}}',
    '{"type":"error","message":"{\\"error\\":{\\"message\\":\\"The model is not supported\\"}}"}',
    '{"type":"turn.failed","error":{"message":"{\\"error\\":{\\"message\\":\\"The model is not supported\\"}}"}}',
    "not json",
  ].join("\n");
  assert.equal(parseCodexEvents(failed).failure, "The model is not supported");
});

test("bare branch names are told apart from URLs and flags", () => {
  assert.equal(looksLikeBranchName("sh/my-branch"), true);
  assert.equal(looksLikeBranchName("https://github.com/o/r/pull/1"), false);
  assert.equal(looksLikeBranchName("github.com/o/r/pull/1"), false);
  assert.equal(looksLikeBranchName("--local"), false);
});
