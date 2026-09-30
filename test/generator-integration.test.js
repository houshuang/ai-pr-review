import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (character) => character.repeat(40);
const diff = (value = "new") => `diff --git a/example.js b/example.js\nindex 3367afd..3e75765 100644\n--- a/example.js\n+++ b/example.js\n@@ -1 +1 @@\n-old\n+${value}\n`;
const section = (narrative = "Explains the change") => ({
  id: "change", title: "Update the value", narrative, diagram: null,
  hunks: [{ file: "example.js", startLine: 1, endLine: 1, annotation: "Replaces the value", importance: "important" }], callouts: [],
});
const walkthrough = (narrative) => ({ title: "Walkthrough", subtitle: "Motivation", overview: "Overview", architecture_diagram: "", sections: [section(narrative)], file_map: [], review_tips: [] });
const patch = (narrative = "Updated narrative") => ({
  updated_sections: [{ id: "change", section: section(narrative) }], added_sections: [], removed_section_ids: [],
  file_map_changes: { added: [], removed: [], updated: [] }, architecture_diagram: null, title: null, subtitle: null, overview: null, review_tips: [],
});
const metadata = (overrides = {}) => ({
  title: "Update the value", body: "Why this matters", url: "https://github.com/example/repo/pull/12",
  baseRefName: "main", baseRefOid: sha("a"), headRefName: "feature", headRefOid: sha("b"), additions: 1, deletions: 1, changedFiles: 1,
  commits: [], files: [{ path: "example.js" }], ...overrides,
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "review-generator-test-"));
  const tool = join(root, "tool");
  const bin = join(root, "bin");
  const invoking = join(root, "invoking");
  for (const directory of [tool, bin, invoking]) mkdirSync(directory);
  cpSync(join(toolRoot, "src"), join(tool, "src"), { recursive: true });
  cpSync(join(toolRoot, "package.json"), join(tool, "package.json"));
  symlinkSync(join(toolRoot, "node_modules"), join(tool, "node_modules"), "dir");
  const statePath = join(root, "state.json");
  const callsPath = join(root, "calls.jsonl");
  const countsPath = join(root, "counts.json");
  const initial = { metadata: metadata(), diff: diff(), delta: diff("next"), comparison: "ahead", walkthrough: walkthrough(), patch: patch() };
  writeFileSync(statePath, JSON.stringify(initial));
  writeFileSync(countsPath, "{}");
  const prelude = `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst state = JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE, 'utf8'));\nconst counts = JSON.parse(fs.readFileSync(process.env.FIXTURE_COUNTS, 'utf8'));\nconst record = (kind, data = {}) => fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({kind,args,...data}) + '\\n');\n`;
  writeFileSync(join(bin, "gh"), prelude + `
if (args[0] === 'pr' && args[1] === 'view') {
  const verification = args[args.indexOf('--json') + 1] === 'headRefOid,baseRefOid';
  record(verification ? 'verify' : 'metadata');
  if (verification && state.verificationFailure) { console.error('verification unavailable'); process.exit(1); }
  const key = verification ? 'verify' : 'metadata';
  const sequence = verification ? state.verifications : state.metadataSequence;
  const index = counts[key] || 0;
  counts[key] = index + 1; fs.writeFileSync(process.env.FIXTURE_COUNTS, JSON.stringify(counts));
  console.log(JSON.stringify(sequence ? sequence[Math.min(index, sequence.length - 1)] : state.metadata));
} else if (args[0] === 'pr' && args[1] === 'diff') {
  record('diff'); console.log(state.diff);
} else if (args[0] === 'api') {
  const endpoint = args[1];
  if (endpoint.includes('/compare/')) {
    record(args.includes('-H') ? 'delta' : 'comparison');
    console.log(args.includes('-H') ? state.delta : JSON.stringify({status: state.comparison}));
  } else { record(endpoint.includes('/comments') ? 'comments' : endpoint.includes('/reviews') ? 'reviews' : 'history'); console.log('[]'); }
} else { console.error('Unexpected gh arguments: ' + JSON.stringify(args)); process.exit(1); }
`, { mode: 0o755 });
  writeFileSync(join(bin, "codex"), prelude + `
let prompt = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
  const task = schema.required.includes('status') ? 'investigation' : schema.required.includes('updated_sections') ? 'patch' : 'generation';
  record(task, {prompt, cwd: process.cwd()});
  const result = task === 'investigation' ? {status:'verified',finding:'example.js:1 contains the expected change',evidence:{files:['example.js:1'],tests:[{command:'static inspection',outcome:'not-run',detail:'The exported constant is directly visible in the source'}]}} : state[task === 'patch' ? 'patch' : 'walkthrough'];
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:50}}));
});
`, { mode: 0o755 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("REVIEW_") && key !== "ANTHROPIC_API_KEY"));
  const env = { ...inherited, PATH: `${bin}:${process.env.PATH}`, REVIEW_AI_PROVIDER: "codex", REVIEW_ORIGINAL_CWD: invoking,
    XDG_CONFIG_HOME: join(root, "config"), FIXTURE_STATE: statePath, FIXTURE_CALLS: callsPath, FIXTURE_COUNTS: countsPath };
  return {
    root, tool, invoking,
    update(values) { writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), ...values })); writeFileSync(countsPath, "{}"); },
    calls() { return existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; },
    output() { return JSON.parse(readFileSync(join(tool, "public", "walkthrough-data.json"), "utf8")); },
    async run(args = ["https://github.com/example/repo/pull/12"], overrides = {}) {
      return await new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, [join(tool, "src", "generate.js"), ...args], { cwd: tool, env: { ...env, ...overrides } });
        let stdout = "", stderr = "";
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
        child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Generator timed out\n${stdout}\n${stderr}`)); }, 20000);
        child.on("error", reject);
        child.on("close", code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
      });
    },
  };
}

function succeeded(result) { assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`); }
function count(f, kind) { return f.calls().filter(call => call.kind === kind).length; }

test("whole generator resumes blocked cached tips automatically and retains completed checks", async t => {
  const f = fixture(t);
  execFileSync("git", ["init", "-b", "main"], { cwd: f.invoking, stdio: "ignore" });
  const git = (...args) => execFileSync("git", args, { cwd: f.invoking, stdio: "ignore" });
  git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  writeFileSync(join(f.invoking, "example.js"), "export const value = 1;\n");
  git("add", "."); git("commit", "-m", "base"); git("checkout", "-b", "feature");
  writeFileSync(join(f.invoking, "example.js"), "export const value = 2;\n");
  git("add", "."); git("commit", "-m", "change");
  succeeded(await f.run(["--local"]));
  const cachePath = join(f.tool, "public", "walkthroughs", readdirSync(join(f.tool, "public", "walkthroughs"))[0]);
  const cached = f.output();
  cached.walkthrough.review_tips = [{tip:"Check the exported constant",status:"info",resolved:false,investigationState:"blocked",finding:"Prior unavailable runtime"}];
  writeFileSync(cachePath, JSON.stringify(cached));
  succeeded(await f.run(["--local"]));
  let complete;
  for (let attempt = 0; attempt < 100; attempt++) {
    complete = JSON.parse(readFileSync(cachePath, "utf8"));
    if (complete.walkthrough.review_tips[0].investigationState === "complete") break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(complete.walkthrough.review_tips[0].investigationState, "complete", JSON.stringify(complete));
  assert.equal(complete.meta.generationId, cached.meta.generationId);
  assert.equal(count(f, "generation"), 1);
  assert.equal(count(f, "investigation"), 1);
  succeeded(await f.run(["--local"]));
  assert.equal(count(f, "investigation"), 1);
  assert.equal(f.output().walkthrough.review_tips[0].investigationState, "complete");
});

test("whole generator publishes validated coverage and reuses exact cache without diff/history/model calls", async t => {
  const f = fixture(t);
  succeeded(await f.run());
  const first = f.output();
  assert.equal(first.meta.source, "github");
  assert.deepEqual(first.walkthrough.file_map.map(file => file.path), ["example.js"]);
  assert.equal(first.meta.baseSha, sha("a"));
  assert.equal(first.meta.headSha, sha("b"));
  const generation = f.calls().find(call => call.kind === "generation");
  assert.equal(generation.args[generation.args.indexOf("--model") + 1], "gpt-6.1-sol");
  assert(generation.args.includes("shell_tool"));
  assert.notEqual(generation.cwd, f.invoking);
  const before = { history: count(f, "history"), diff: count(f, "diff"), generation: count(f, "generation"), comments: count(f, "comments"), reviews: count(f, "reviews") };
  succeeded(await f.run());
  assert.equal(f.output().meta.generationId, first.meta.generationId);
  assert.equal(f.output().meta.generatedAt, first.meta.generatedAt);
  for (const kind of ["diff", "history", "generation"]) assert.equal(count(f, kind), before[kind]);
  for (const kind of ["comments", "reviews"]) assert.equal(count(f, kind), before[kind] + 1);
  const slugFile = readdirSync(join(f.tool, "public", "walkthroughs"))[0];
  assert.deepEqual(JSON.parse(readFileSync(join(f.tool, "public", "walkthroughs", slugFile))), f.output());
});

test("whole generator invalidates model, base revision and same-head description changes", async t => {
  const f = fixture(t);
  succeeded(await f.run());
  const original = f.output().meta.generationId;
  succeeded(await f.run(undefined, { REVIEW_CODEX_GENERATION_MODEL: "gpt-6-astra" }));
  assert.notEqual(f.output().meta.generationId, original);
  f.update({ metadata: metadata({ baseRefOid: sha("c") }) });
  succeeded(await f.run(undefined, { REVIEW_CODEX_GENERATION_MODEL: "gpt-6-astra" }));
  assert.equal(f.output().meta.baseSha, sha("c"));
  f.update({ metadata: metadata({ baseRefOid: sha("c"), body: "Changed motivation" }) });
  succeeded(await f.run(undefined, { REVIEW_CODEX_GENERATION_MODEL: "gpt-6-astra" }));
  assert.equal(count(f, "generation"), 4);
  assert.equal(count(f, "patch"), 0);
});

test("whole generator regenerates syntactically valid caches with invalid hunk references", async t => {
  const f = fixture(t);
  succeeded(await f.run());
  const first = f.output();
  const path = join(f.tool, "public", "walkthroughs", "example-repo-12.json");
  const corrupted = JSON.parse(readFileSync(path, "utf8"));
  corrupted.walkthrough.sections[0].hunks[0].startLine = 500;
  corrupted.walkthrough.sections[0].hunks[0].endLine = 500;
  writeFileSync(path, JSON.stringify(corrupted));
  succeeded(await f.run());
  assert.equal(count(f, "generation"), 2);
  assert.notEqual(f.output().meta.generationId, first.meta.generationId);
  assert.equal(f.output().walkthrough.sections[0].hunks[0].startLine, 1);
});

test("whole generator applies a valid incremental patch and regenerates when semantic validation fails", async t => {
  const f = fixture(t);
  succeeded(await f.run());
  f.update({ metadata: metadata({ headRefOid: sha("c") }), diff: diff("next") });
  succeeded(await f.run());
  assert.equal(f.output().walkthrough.sections[0].narrative, "Updated narrative");
  assert.equal(count(f, "generation"), 1);
  assert.equal(count(f, "patch"), 1);
  const malformed = patch();
  malformed.updated_sections[0].section.hunks[0].startLine = 999;
  malformed.updated_sections[0].section.hunks[0].endLine = 999;
  f.update({ metadata: metadata({ headRefOid: sha("d") }), diff: diff("later"), patch: malformed, walkthrough: walkthrough("Fresh fallback") });
  const result = await f.run();
  succeeded(result);
  assert.match(result.stdout, /Incremental update failed/);
  assert.equal(f.output().walkthrough.sections[0].narrative, "Fresh fallback");
  assert.equal(count(f, "generation"), 2);
  assert.equal(count(f, "patch"), 2);
});

test("whole generator regenerates for diverged GitHub history and preserves cache on invalid full output", async t => {
  const f = fixture(t);
  succeeded(await f.run());
  f.update({ metadata: metadata({ headRefOid: sha("c") }), comparison: "diverged", walkthrough: walkthrough("Rewritten history") });
  succeeded(await f.run());
  assert.equal(count(f, "generation"), 2);
  assert.equal(count(f, "patch"), 0);
  assert.equal(count(f, "delta"), 0);
  const saved = readFileSync(join(f.tool, "public", "walkthrough-data.json"), "utf8");
  const invalid = walkthrough();
  invalid.sections[0].hunks[0].file = "invented.js";
  f.update({ walkthrough: invalid });
  const result = await f.run(["https://github.com/example/repo/pull/12", "--force"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown hunk file: invented.js/);
  assert.equal(readFileSync(join(f.tool, "public", "walkthrough-data.json"), "utf8"), saved);
});

test("whole generator retries moving head/base and refuses persistently unstable or unverifiable revisions", async t => {
  const f = fixture(t);
  const final = metadata({ headRefOid: sha("c"), baseRefOid: sha("d") });
  f.update({ metadataSequence: [metadata(), final], verifications: [final, final] });
  succeeded(await f.run());
  assert.equal(count(f, "metadata"), 2);
  assert.equal(f.output().meta.headSha, sha("c"));
  assert.equal(f.output().meta.baseSha, sha("d"));
  const saved = readFileSync(join(f.tool, "public", "walkthrough-data.json"), "utf8");
  f.update({ metadataSequence: [metadata()], verifications: [final] });
  const unstable = await f.run(["https://github.com/example/repo/pull/12", "--force"]);
  assert.equal(unstable.code, 1);
  assert.match(unstable.stderr, /base or head changed/);
  assert.equal(count(f, "metadata"), 5);
  assert.equal(readFileSync(join(f.tool, "public", "walkthrough-data.json"), "utf8"), saved);
  f.update({ verificationFailure: true });
  const unavailable = await f.run(["https://github.com/example/repo/pull/12", "--force"]);
  assert.equal(unavailable.code, 1);
  assert.match(unavailable.stderr, /verification unavailable/);
  assert.equal(count(f, "generation"), 1);
});

test("whole generator reads a relative patch from original cwd and caches its content", async t => {
  const f = fixture(t);
  writeFileSync(join(f.invoking, "changes.patch"), diff());
  succeeded(await f.run(["--diff", "changes.patch"]));
  const first = f.output();
  assert.equal(first.meta.source, "file");
  assert.equal(first.meta.title, join(f.invoking, "changes.patch"));
  assert.equal(first.meta.headSha, null);
  const cached = await f.run(["--diff", "changes.patch"]);
  succeeded(cached);
  assert.match(cached.stdout, /patch content unchanged/);
  assert.equal(f.output().meta.generationId, first.meta.generationId);
  assert.equal(count(f, "generation"), 1);
  assert.equal(count(f, "metadata"), 0);
  writeFileSync(join(f.invoking, "changes.patch"), diff("replacement"));
  succeeded(await f.run(["--diff", "changes.patch"]));
  assert.equal(count(f, "generation"), 2);
  assert.notEqual(f.output().meta.generationId, first.meta.generationId);
});

test("whole generator accepts --local --force and leaves dirty invoking checkout unchanged", async t => {
  const f = fixture(t);
  const git = (...args) => execFileSync("git", args, { cwd: f.invoking, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  writeFileSync(join(f.invoking, "example.js"), "old\n"); git("add", "example.js"); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("switch", "-c", "feature");
  writeFileSync(join(f.invoking, "example.js"), "new\n"); git("add", "example.js"); git("commit", "-m", "change");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(f.invoking, "example.js"), "dirty working tree\n");
  writeFileSync(join(f.invoking, "private.txt"), "Untracked fixture\n");
  const status = git("status", "--porcelain=v1");
  succeeded(await f.run(["--local", "--force"]));
  const first = f.output();
  assert.equal(first.meta.source, "local");
  assert.equal(first.meta.baseSha, base); assert.equal(first.meta.headSha, head);
  assert.match(first.diff, /\+new/); assert.doesNotMatch(first.diff, /dirty working tree/);
  assert.equal(git("status", "--porcelain=v1"), status);
  assert.equal(git("rev-parse", "HEAD"), head);
  succeeded(await f.run(["--force", "--local"]));
  assert.equal(count(f, "generation"), 2);
  assert.notEqual(f.output().meta.generationId, first.meta.generationId);
  assert.equal(git("status", "--porcelain=v1"), status);
});

test("whole generator regenerates after local branch history is rewritten", async t => {
  const f = fixture(t);
  const git = (...args) => execFileSync("git", args, { cwd: f.invoking, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  writeFileSync(join(f.invoking, "example.js"), "old\n"); git("add", "example.js"); git("commit", "-m", "base");
  git("switch", "-c", "feature");
  writeFileSync(join(f.invoking, "example.js"), "new\n"); git("add", "example.js"); git("commit", "-m", "first change");
  succeeded(await f.run(["--local"]));
  const originalHead = f.output().meta.headSha;
  git("switch", "-c", "replacement", "main");
  writeFileSync(join(f.invoking, "example.js"), "replacement\n"); git("add", "example.js"); git("commit", "-m", "rewritten change");
  git("branch", "-f", "feature", "HEAD"); git("switch", "feature");
  assert.notEqual(git("merge-base", originalHead, "HEAD"), originalHead);
  f.update({ walkthrough: walkthrough("Full rewritten walkthrough") });
  succeeded(await f.run(["--local"]));
  assert.equal(count(f, "patch"), 0);
  assert.equal(count(f, "generation"), 2);
  assert.equal(f.output().walkthrough.sections[0].narrative, "Full rewritten walkthrough");
  const rewrittenHead = git("rev-parse", "HEAD");
  git("commit", "--amend", "-m", "same tree, new history");
  assert.notEqual(git("rev-parse", "HEAD"), rewrittenHead);
  assert.equal(git("diff", rewrittenHead, "HEAD"), "");
  succeeded(await f.run(["--local"]));
  assert.equal(count(f, "patch"), 0);
  assert.equal(count(f, "generation"), 3);
});
