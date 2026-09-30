import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexEvents } from "../src/ai-provider.js";
import { looksLikeBranchName } from "../src/resolve-branch.js";

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodex } from "../src/ai-provider.js";
import { getTaskConfig } from "../src/models.js";

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

test("task defaults and legacy/global/stage overrides have deterministic precedence", () => {
  assert.deepEqual(getTaskConfig("codex", "generation", {}), { model: "gpt-6.1-sol", effort: "medium" });
  assert.equal(getTaskConfig("codex", "investigation", {}).effort, "high");
  assert.equal(getTaskConfig("codex", "chat", {}).effort, "low");
  assert.equal(getTaskConfig("claude", "generation", {}).model, "claude-opus-5-5");
  assert.equal(getTaskConfig("claude", "repair", {}).model, "claude-haiku-4-5-20251001");
  assert.equal(getTaskConfig("claude", "chat", {}).effort, "low");
  assert.deepEqual(getTaskConfig("codex", "patch", {
    REVIEW_CODEX_MODEL: "global", REVIEW_CODEX_PATCH_MODEL: "stage",
    REVIEW_CODEX_EFFORT: "high", REVIEW_CODEX_PATCH_EFFORT: "low",
  }), { model: "stage", effort: "low" });
  assert.equal(getTaskConfig("codex", "repair", { REVIEW_CODEX_MODEL: "legacy" }).model, "legacy");
  assert.equal(getTaskConfig("claude", "generation", { REVIEW_MODEL: "legacy" }).model, "legacy");
  assert.throws(() => getTaskConfig("codex", "typo", {}), /Unsupported AI task/);
  assert.throws(() => getTaskConfig("codex", "chat", { REVIEW_CODEX_CHAT_EFFORT: "typo" }), /Invalid/);
});

function fakeCodex(body) {
  const dir = mkdtempSync(join(tmpdir(), "fake-review-codex-"));
  const capture = join(dir, "capture.json");
  const script = `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nconst output = args[args.indexOf('--output-last-message') + 1];\nconst schemaPath = args.includes('--output-schema') ? args[args.indexOf('--output-schema') + 1] : null;\nlet prompt = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', chunk => prompt += chunk);\nprocess.stdin.on('end', () => {\nfs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, prompt, output, schemaPath, schema: schemaPath ? JSON.parse(fs.readFileSync(schemaPath)) : null, codexHome: process.env.CODEX_HOME }));\n${body}\n});\n`;
  symlinkSync(process.execPath, join(dir, "node"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(join(dir, "codex"), script);
  chmodSync(join(dir, "codex"), 0o755);
  return {
    dir, capture,
    run: (options = {}) => runCodex({ userPrompt: "review this", cwd: dir,
      env: { PATH: dir, CODEX_HOME: "/existing-auth-home" }, ...options }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const send = (event) => `process.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")});`;

test("Codex sends stdin/schema, explicit task config, preserves auth, and removes output files", async () => {
  const fake = fakeCodex(`fs.writeFileSync(output, '{"ok":true}');
    ${send({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2 } })}`);
  try {
    let usage;
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    assert.equal(await fake.run({ task: "investigation", systemPrompt: "read only", userPrompt: "p".repeat(200000), outputSchema: schema, onUsage: u => usage = u }), '{"ok":true}');
    const captured = JSON.parse(readFileSync(fake.capture, "utf8"));
    assert.equal(captured.args.at(-1), "-");
    assert.equal(captured.args[captured.args.indexOf("--model") + 1], "gpt-6.1-sol");
    assert.ok(captured.args.includes('model_reasoning_effort="high"'));
    assert.ok(captured.args.includes("--ignore-user-config"));
    assert.ok(captured.args.includes("project_doc_max_bytes=0"));
    assert.ok(captured.args.some(a => a.endsWith('.trust_level="untrusted"')));
    assert.ok(!captured.args.includes("--ignore-rules"));
    assert.equal(captured.codexHome, "/existing-auth-home");
    assert.ok(captured.prompt.startsWith("<instructions>\nread only"));
    assert.ok(captured.prompt.includes("p".repeat(200000)));
    assert.deepEqual(captured.schema, schema);
    assert.equal(existsSync(captured.output), false);
    assert.equal(existsSync(captured.schemaPath), false);
    assert.deepEqual(usage, { input: 20, cachedInput: 5, output: 2, reasoningOutput: 0 });
  } finally { fake.cleanup(); }
});

test("fragmented UTF-8 JSONL streams text before exit and never repeats completed item text", async () => {
  const event = JSON.stringify({ type: "item.delta", item_id: "a", delta: "héllo" }) + "\n";
  const fake = fakeCodex(`
    const bytes = Buffer.from(${JSON.stringify(event)});
    const split = bytes.indexOf(0xc3) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => {
      process.stdout.write(bytes.subarray(split));
      ${send({ type: "item.updated", item: { id: "a", type: "agent_message", text: "héllo world" } })}
      ${send({ type: "item.completed", item: { id: "a", type: "agent_message", text: "héllo world" } })}
      setTimeout(() => fs.writeFileSync(output, 'héllo world'), 150);
    }, 20);`);
  try {
    let completed = false;
    const texts = [];
    const answer = await fake.run({ onText: text => { assert.equal(completed, false); if (text) texts.push(text); } });
    completed = true;
    assert.equal(answer, "héllo world");
    assert.deepEqual(texts, ["héllo", " world"]);
  } finally { fake.cleanup(); }
});

test("CLI versions with completed messages only still emit text", async () => {
  const fake = fakeCodex(`fs.writeFileSync(output, 'answer');
    ${send({ type: "item.completed", item: { id: "a", type: "agent_message", text: "answer" } })}`);
  try {
    const texts = [];
    assert.equal(await fake.run({ onText: text => texts.push(text) }), "answer");
    assert.deepEqual(texts, ["answer"]);
  } finally { fake.cleanup(); }
});

test("timeouts escalate to SIGKILL, wait for exit, and clean temporary files", async () => {
  const fake = fakeCodex(`process.on('SIGTERM', () => {}); setInterval(() => {}, 100);`);
  try {
    await assert.rejects(fake.run({ timeoutMs: 1000, killGraceMs: 20 }), /timed out/);
    const captured = JSON.parse(readFileSync(fake.capture, "utf8"));
    assert.equal(existsSync(captured.output), false);
  } finally { fake.cleanup(); }
});

test("abort kills active child and already aborted signals never start a child", async () => {
  const fake = fakeCodex(`process.stderr.write("ready"); setInterval(() => {}, 100);`);
  try {
    const controller = new AbortController();
    const promise = fake.run({ signal: controller.signal, onProgress: () => controller.abort() });
    await assert.rejects(promise, /aborted/);
    const captured = JSON.parse(readFileSync(fake.capture, "utf8"));
    assert.equal(existsSync(captured.output), false);
    rmSync(fake.capture);
    await assert.rejects(fake.run({ signal: controller.signal }), /aborted/);
    assert.equal(existsSync(fake.capture), false);
  } finally { fake.cleanup(); }
});

test("structured failures surface useful errors even after large diagnostics", async () => {
  const fake = fakeCodex(`process.stderr.write('x'.repeat(200000));
    ${send({ type: "turn.failed", error: { message: '{"error":{"message":"The model is not supported"}}' } })}
    process.exitCode = 1;`);
  try {
    await assert.rejects(fake.run(), err => {
      assert.match(err.message, /model is not supported/);
      assert.equal(err.codexSetupFailure, true);
      assert.ok(err.message.length < 600);
      return true;
    });
  } finally { fake.cleanup(); }
});

test("turn.failed rejects even when the CLI exits zero", async () => {
  const fake = fakeCodex(`fs.writeFileSync(output, '');
    ${send({ type: "turn.failed", error: { message: "could not finish" } })}`);
  try { await assert.rejects(fake.run(), /could not finish/); }
  finally { fake.cleanup(); }
});

test("missing CLI and missing output produce actionable failures", async () => {
  await assert.rejects(runCodex({ userPrompt: "x", env: { PATH: "/does-not-exist" } }), err => {
    assert.equal(err.codexSetupFailure, true);
    assert.match(err.message, /CLI not found/);
    return true;
  });
  const fake = fakeCodex("");
  try { await assert.rejects(fake.run(), /without a readable final response/); }
  finally { fake.cleanup(); }
});

test("stdin write failures terminate the child and release temporary output", async () => {
  const fake = fakeCodex("");
  writeFileSync(join(fake.dir, "codex"), `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(fake.capture)}, JSON.stringify({ output: args[args.indexOf('--output-last-message') + 1] }));
fs.closeSync(0);
setInterval(() => {}, 100);
`);
  try {
    await assert.rejects(fake.run({ userPrompt: "x".repeat(1024 * 1024), timeoutMs: 2000 }), /Could not send prompt/);
    const captured = JSON.parse(readFileSync(fake.capture, "utf8"));
    assert.equal(existsSync(captured.output), false);
  } finally { fake.cleanup(); }
});

test("timeout also kills descendants holding inherited output pipes", { skip: process.platform === "win32" }, async () => {
  const fake = fakeCodex(`
    import('node:child_process').then(({ spawn }) => {
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 100); setTimeout(() => process.exit(0), 3500)'], { stdio: ['ignore', 'inherit', 'inherit'] });
      setInterval(() => {}, 100);
    });
  `);
  try {
    const started = Date.now();
    await assert.rejects(fake.run({ timeoutMs: 1000, killGraceMs: 20 }), /timed out/);
    assert.ok(Date.now() - started < 3000, "descendants must not keep close waiting indefinitely");
  } finally { fake.cleanup(); }
});

test("oversized unterminated events fail without retaining an unbounded transcript", async () => {
  const fake = fakeCodex(`process.stdout.write('x'.repeat(5 * 1024 * 1024)); setInterval(() => {}, 100);`);
  try { await assert.rejects(fake.run({ timeoutMs: 2000 }), /event exceeded 4 MB/); }
  finally { fake.cleanup(); }
});

test("an older CLI's lowercase argument error is classified as a setup failure", async () => {
  const fake = fakeCodex(`process.stderr.write("error: unexpected argument '--ignore-user-config' found\\nUsage: codex exec [OPTIONS]\\nFor more information, try '--help'.\\n"); process.exitCode = 2;`);
  try {
    await assert.rejects(fake.run(), err => {
      assert.match(err.message, /upgrade the Codex CLI/);
      assert.equal(err.codexSetupFailure, true);
      return true;
    });
  } finally { fake.cleanup(); }
});
