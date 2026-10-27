import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/claude-agent.js";
import { runAgent } from "../src/ai-provider.js";

function fakeClaude(body) {
  const dir = mkdtempSync(join(tmpdir(), "fake-review-claude-"));
  const capture = join(dir, "capture.json");
  const script = `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nconst send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');\nlet prompt = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', chunk => prompt += chunk);\nprocess.stdin.on('end', () => {\nfs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, prompt, cwd: process.cwd() }));\n${body}\n});\n`;
  symlinkSync(process.execPath, join(dir, "node"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(join(dir, "claude"), script);
  chmodSync(join(dir, "claude"), 0o755);
  return {
    capture: () => JSON.parse(readFileSync(capture, "utf8")),
    run: (options = {}) => runClaude({ userPrompt: "review this", cwd: dir, env: { PATH: dir }, ...options }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const success = (fields) => `send(${JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 3, cache_read_input_tokens: 10, output_tokens: 4 }, ...fields })});`;

test("research gets read-only file tools, the base checkout and structured output; user settings stay out", async () => {
  const fake = fakeClaude(`send({ type: "assistant", message: { content: [{ type: "tool_use", name: "Grep" }] } });
    send({ type: "user", message: { content: [{ type: "tool_result" }] } });
    ${success({ structured_output: { title: "T", markdown: "M", references: [] } })}`);
  try {
    const activity = [];
    let usage;
    const schema = { type: "object", properties: { title: { type: "string" } } };
    const text = await fake.run({ task: "research", systemPrompt: "teach", readableDirs: ["/base", undefined], outputSchema: schema, onActivity: (event) => activity.push(event.type), onUsage: (value) => { usage = value; } });
    assert.deepEqual(JSON.parse(text), { title: "T", markdown: "M", references: [] });
    const { args, prompt } = fake.capture();
    assert.equal(prompt, "review this");
    assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
    assert.equal(args[args.indexOf("--setting-sources") + 1], "");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.deepEqual(args.filter((arg, index) => args[index - 1] === "--add-dir"), ["/base"]);
    assert.equal(args[args.indexOf("--model") + 1], "claude-opus-5-5");
    assert.equal(args[args.indexOf("--effort") + 1], "high");
    assert.equal(args[args.indexOf("--append-system-prompt") + 1], "teach");
    assert.deepEqual(JSON.parse(args[args.indexOf("--json-schema") + 1]), schema);
    assert.deepEqual(activity, ["command-started", "command-completed"]);
    assert.deepEqual(usage, { input: 13, cachedInput: 10, output: 4, reasoningOutput: 0 });
  } finally { fake.cleanup(); }
});

test("text tasks get no tools, and chat streams text deltas", async () => {
  const fake = fakeClaude(`send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } });
    send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "x" } } });
    send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } });
    ${success({ result: "Hello" })}`);
  try {
    assert.equal(await fake.run({ task: "repair" }), "Hello");
    let args = fake.capture().args;
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.ok(!args.includes("--add-dir"));
    let streamed = "";
    assert.equal(await fake.run({ task: "chat", allowShell: true, readableDirs: ["/base"], onText: (delta) => { streamed += delta; } }), "Hello");
    args = fake.capture().args;
    assert.equal(streamed, "Hello");
    assert.ok(args.includes("--include-partial-messages"));
    assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
  } finally { fake.cleanup(); }
});

test("an error result rejects with its message and rate limits are retried", async () => {
  const fake = fakeClaude(`const count = fs.existsSync('attempts') ? Number(fs.readFileSync('attempts', 'utf8')) : 0;
    fs.writeFileSync('attempts', String(count + 1));
    if (count === 0) send({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529 overloaded" });
    else ${success({ result: "ok" })}`);
  const retries = [];
  try {
    assert.equal(await fake.run({ retryDelaysMs: [1], onRetry: ({ attempt }) => retries.push(attempt) }), "ok");
    assert.deepEqual(retries, [1]);
  } finally { fake.cleanup(); }
  const login = fakeClaude(`send({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }); process.exit(1);`);
  try {
    await assert.rejects(login.run({ retryDelaysMs: [1] }), (err) => err.codexSetupFailure && !err.codexTransient && /Not logged in/.test(err.message));
  } finally { login.cleanup(); }
});

test("runAgent dispatches on the explicit provider", async () => {
  await assert.rejects(runAgent({ provider: "claude", userPrompt: "x", env: { PATH: "/nonexistent" } }), /Claude Code CLI not found/);
  await assert.rejects(runAgent({ provider: "codex", userPrompt: "x", env: { PATH: "/nonexistent" } }), /Codex CLI not found/);
});
