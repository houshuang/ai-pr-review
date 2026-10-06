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

test("runCodex reports Codex's exit instead of EPIPE when it quits before reading the prompt", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runCodex } = await import("../src/ai-provider.js");

  const binDir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const fake = join(binDir, "codex");
  writeFileSync(fake, "#!/bin/sh\necho 'Error: not logged in' >&2\nexit 1\n");
  chmodSync(fake, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    await assert.rejects(
      runCodex({ userPrompt: "x".repeat(4 * 1024 * 1024) }),
      (err) => {
        assert.match(err.message, /Codex exited with code 1/);
        assert.match(err.message, /not logged in/);
        return true;
      }
    );
  } finally {
    process.env.PATH = originalPath;
  }
});
