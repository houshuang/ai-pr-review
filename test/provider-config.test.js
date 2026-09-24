import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  chooseProvider,
  configPath,
  describeChoice,
  parseProviderArgs,
  readSavedProvider,
  resolveProviderSync,
  saveProvider,
} from "../src/provider-config.js";

const CLI = resolve(fileURLToPath(import.meta.url), "../../src/provider-config.js");

let dir;
let toolRoot;
let binWithCodex;
let emptyBin;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "provider-config-test-"));
  toolRoot = join(dir, "tool");
  mkdirSync(toolRoot);
  binWithCodex = join(dir, "bin");
  mkdirSync(binWithCodex);
  writeFileSync(join(binWithCodex, "codex"), "#!/bin/sh\n");
  chmodSync(join(binWithCodex, "codex"), 0o755);
  emptyBin = join(dir, "empty-bin");
  mkdirSync(emptyBin);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = (extra = {}) => ({ XDG_CONFIG_HOME: join(dir, "config"), PATH: emptyBin, ...extra });

function terminal(answers) {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (chunk) => (transcript += chunk));
  input.end(answers.map((a) => `${a}\n`).join(""));
  return { input, output, transcript: () => transcript };
}

test("config lives under XDG_CONFIG_HOME, else ~/.config", () => {
  assert.equal(configPath({ XDG_CONFIG_HOME: "/x" }), "/x/ai-pr-review/config.json");
  assert.equal(configPath({ HOME: "/home/u" }), "/home/u/.config/ai-pr-review/config.json");
});

test("first interactive run asks, saves the answer, and later runs reuse it", async () => {
  const e = env({ PATH: binWithCodex });
  const term = terminal(["2"]);
  const choice = await chooseProvider({ env: e, interactive: true, toolRoot, ...term });
  assert.deepEqual(choice, { provider: "codex", source: "saved default" });
  assert.match(term.transcript(), /Which AI should generate walkthroughs by default\?/);
  assert.match(term.transcript(), /Codex CLI \(found\)/);
  assert.equal(JSON.parse(readFileSync(configPath(e), "utf-8")).provider, "codex");

  const again = terminal([]);
  const second = await chooseProvider({ env: e, interactive: true, toolRoot, ...again });
  assert.deepEqual(second, { provider: "codex", source: "saved default" });
  assert.equal(again.transcript(), "", "no prompt once a default is saved");
});

test("prompt re-asks on invalid input and accepts names", async () => {
  const term = terminal(["maybe", "claude"]);
  const choice = await chooseProvider({ env: env(), interactive: true, toolRoot, ...term });
  assert.equal(choice.provider, "claude");
  assert.match(term.transcript(), /Please answer 1 \(Claude\) or 2 \(Codex\)/);
});

test("pressing enter takes the suggestion, which prefers an available provider", async () => {
  const codexOnly = terminal([""]);
  const e = env({ PATH: binWithCodex });
  assert.equal((await chooseProvider({ env: e, interactive: true, toolRoot, ...codexOnly })).provider, "codex");
  assert.match(codexOnly.transcript(), /Choose 1 or 2 \[2\]/);

  rmSync(join(dir, "config"), { recursive: true });
  const withKey = terminal([""]);
  const e2 = env({ PATH: binWithCodex, ANTHROPIC_API_KEY: "sk-ant-test" });
  assert.equal((await chooseProvider({ env: e2, interactive: true, toolRoot, ...withKey })).provider, "claude");
});

test("--set-default overwrites the saved default and keeps other config keys", async () => {
  const e = env();
  mkdirSync(join(dir, "config", "ai-pr-review"), { recursive: true });
  writeFileSync(configPath(e), JSON.stringify({ provider: "codex", other: 1 }));
  const choice = await chooseProvider({ env: e, setDefault: "claude", interactive: true, toolRoot });
  assert.deepEqual(choice, { provider: "claude", source: "saved default" });
  assert.deepEqual(JSON.parse(readFileSync(configPath(e), "utf-8")), { provider: "claude", other: 1 });
});

test("--claude/--codex override the saved default for one run without saving", async () => {
  const e = env();
  saveProvider("claude", e);
  const choice = await chooseProvider({ env: e, flag: "codex", interactive: true, toolRoot });
  assert.deepEqual(choice, { provider: "codex", source: "--codex" });
  assert.equal(readSavedProvider(e), "claude");
});

test("REVIEW_AI_PROVIDER overrides the saved default; a flag overrides both", async () => {
  const e = env({ REVIEW_AI_PROVIDER: "Codex" });
  saveProvider("claude", e);
  assert.deepEqual(await chooseProvider({ env: e, toolRoot }), { provider: "codex", source: "REVIEW_AI_PROVIDER" });
  assert.equal((await chooseProvider({ env: e, flag: "claude", toolRoot })).provider, "claude");
  assert.throws(() => resolveProviderSync({ env: env({ REVIEW_AI_PROVIDER: "gpt" }), toolRoot }), /REVIEW_AI_PROVIDER/);
});

test("REVIEW_AI_PROVIDER on a first run skips the prompt and saves nothing", async () => {
  const e = env({ REVIEW_AI_PROVIDER: "claude" });
  const term = terminal([]);
  assert.equal((await chooseProvider({ env: e, interactive: true, toolRoot, ...term })).provider, "claude");
  assert.equal(term.transcript(), "");
  assert.equal(readSavedProvider(e), null);
});

test("non-interactive first run: Claude with a key, else Codex on PATH, else an error", async () => {
  const withKey = await chooseProvider({ env: env({ ANTHROPIC_API_KEY: "sk-ant-x", PATH: binWithCodex }), toolRoot });
  assert.equal(withKey.provider, "claude");
  assert.match(withKey.source, /fallback/);

  writeFileSync(join(toolRoot, ".env"), "ANTHROPIC_API_KEY=sk-ant-real\n");
  assert.equal((await chooseProvider({ env: env({ PATH: binWithCodex }), toolRoot })).provider, "claude", ".env key counts");
  writeFileSync(join(toolRoot, ".env"), "ANTHROPIC_API_KEY=sk-ant-...\n");
  assert.equal((await chooseProvider({ env: env({ PATH: binWithCodex }), toolRoot })).provider, "codex", "placeholder does not count");

  await assert.rejects(chooseProvider({ env: env(), toolRoot }), /No AI provider available/);
  assert.equal(readSavedProvider(env()), null, "fallback never saves");
});

test("argument parsing pulls provider options out wherever they appear", () => {
  assert.deepEqual(parseProviderArgs(["https://x/pull/1", "--claude", "--force"]), {
    flag: "claude",
    setDefault: null,
    rest: ["https://x/pull/1", "--force"],
  });
  assert.deepEqual(parseProviderArgs(["--set-default", "codex", "--local"]), {
    flag: null,
    setDefault: "codex",
    rest: ["--local"],
  });
  assert.equal(parseProviderArgs(["--set-default=Claude"]).setDefault, "claude");
  assert.throws(() => parseProviderArgs(["--set-default"]), /needs a value/);
  assert.throws(() => parseProviderArgs(["--set-default", "gpt"]), /Unsupported/);
});

test("the status line names the provider, why, and how to change it", () => {
  assert.equal(
    describeChoice({ provider: "codex", source: "saved default" }),
    "AI provider: Codex (saved default) — --claude for one run, review --set-default claude to change the default"
  );
});

test("CLI never blocks without a TTY and reports provider on stdout", () => {
  const run = (args, extra = {}) =>
    spawnSync(process.execPath, [CLI, ...args], {
      env: { ...env(extra), HOME: dir },
      input: "",
      encoding: "utf-8",
      timeout: 10000,
    });

  const fallback = run([], { PATH: binWithCodex });
  assert.equal(fallback.status, 0);
  assert.equal(fallback.stdout, "codex\n");
  assert.match(fallback.stderr, /AI provider: Codex \(fallback: codex CLI found\)/);

  const none = run([]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No AI provider available/);

  const set = run(["--set-default", "claude"]);
  assert.equal(set.status, 0);
  assert.match(set.stderr, /Default AI provider set to Claude/);
  assert.equal(run([]).stdout, "claude\n");
  assert.equal(run(["--codex"]).stdout, "codex\n");
});
