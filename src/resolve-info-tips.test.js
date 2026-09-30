import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { writeReviewFile } from "./review-storage.js";

const src = dirname(fileURLToPath(import.meta.url));
const requireLogs = (root) => readFileSync(join(root,"logs",readdirSync(join(root,"logs"))[0]),"utf8");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function fixture(t, scenario = "normal", tips = [{ tip: "check code", status: "info", pending: true }]) {
  const root = mkdtempSync(join(tmpdir(), "review-resolver-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  for (const name of ["resolve-info-tips.js", "review-storage.js", "repo-snapshot.js", "ai-provider.js", "models.js", "provider-config.js"]) copyFileSync(join(src, name), join(root, "src", name));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  mkdirSync(join(root, "public", "walkthroughs"), { recursive: true });
  mkdirSync(join(root, "bin"));
  const record = join(root, "calls");
  writeFileSync(join(root, "bin", "codex"), `#!/usr/bin/env node
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
let input = ''; process.stdin.on('data', data => input += data); process.stdin.on('end', async () => {
  const args = process.argv.slice(2);
  fs.appendFileSync(process.env.RECORD, JSON.stringify({cwd:process.cwd(),sandbox:args[args.indexOf('--sandbox')+1],prompt:input})+'\\n');
  fs.writeFileSync(process.env.RECORD + '.started', 'started');
  if (process.env.SCENARIO === 'slow') await new Promise(done => setTimeout(done, 180));
  if (process.env.SCENARIO === 'timeout') await new Promise(done => setTimeout(done, 30000));
  if (process.env.SCENARIO === 'failure') { process.stderr.write('ERROR: not logged in\\n'); process.exit(1); }
  const testEnv={...process.env}; delete testEnv.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath,['--test','check.test.cjs'],{encoding:'utf8',env:testEnv});
  let result = {status: 'concern', finding: fs.readFileSync('code.txt', 'utf8').trim(),evidence:{files:['code.txt:1'],tests:[{command:'node --test check.test.cjs',outcome:'passed',detail:output}]}};
  if (process.env.SCENARIO === 'invalid') result.status = 'invented';
  if (process.env.SCENARIO === 'info') result = {status:'info',finding:'external service is unavailable',evidence:{files:['code.txt:1'],tests:[{command:'remote integration test',outcome:'not-run',detail:'requires an unavailable external service'}]}};
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));
  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}) + '\\n');
});`, { mode: 0o755 });
  const repo = join(root, "repository");
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  writeFileSync(join(repo, "code.txt"), "evidence at recorded commit\n");
  writeFileSync(join(repo, "check.test.cjs"), `const fs=require('node:fs');require('node:test')('pinned code and writable artifacts',()=>{require('node:assert/strict').equal(fs.readFileSync('code.txt','utf8'),'evidence at recorded commit\\n');fs.writeFileSync('generated.txt','test output')});`);
  git("add", "."); git("commit", "-m", "reviewed");
  const meta = { generationId: "first-generation", source: "local", headSha: git("rev-parse", "HEAD"), repositoryPath: repo, aiProvider: "claude" };
  writeFileSync(join(repo, "code.txt"), "dirty evidence must not be seen\n");
  const content = { meta, diff: "reviewed diff", walkthrough: { review_tips: tips } };
  const jsonPath = join(root, "public", "walkthroughs", "review.json");
  writeFileSync(jsonPath, JSON.stringify(content));
  const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, RECORD: record, SCENARIO: scenario, REVIEW_AI_PROVIDER: "claude", ANTHROPIC_API_KEY: "", REVIEW_TIP_TIMEOUT_MS: scenario === "timeout" ? "1000" : "10000" };
  const run = () => {
    const child = spawn(process.execPath, [join(root, "src", "resolve-info-tips.js"), "review", repo], { cwd: root, env, stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`))); });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    return done;
  };
  return { root, repo, content, jsonPath, record, run, read: () => JSON.parse(readFileSync(jsonPath, "utf8")), calls: () => readFileSync(record, "utf8").trim().split("\n").map(JSON.parse) };
}

test("Claude-generated tips use Codex without an Anthropic key and execute tests in an isolated pinned worktree", async (t) => {
  const f = fixture(t);
  await f.run();
  const tip = f.read().walkthrough.review_tips[0];
  assert.equal(tip.status, "concern", tip.finding + "\n" + requireLogs(f.root));
  assert.equal(tip.finding, "evidence at recorded commit");
  assert.equal(tip.pending, undefined);
  assert.equal(tip.investigationState, "complete");
  assert.equal(tip.evidence.tests[0].outcome, "passed");
  assert.match(tip.evidence.tests[0].detail, /pass 1/);
  const [call] = f.calls();
  assert.equal(call.sandbox, "workspace-write");
  assert.equal(existsSync(call.cwd), false);
  assert.equal(readFileSync(join(f.repo, "code.txt"), "utf8"), "dirty evidence must not be seen\n");
  assert.equal(existsSync(join(f.repo, "generated.txt")), false);
  await f.run();
  assert.equal(f.calls().length, 1);
});

test("every legacy diff verdict is investigated, including verified and concern", async (t) => {
  const f = fixture(t, "normal", ["verified", "concern", "info"].map((status) => ({ tip: `check ${status}`, status, resolved: true })));
  await f.run();
  assert.equal(f.calls().length, 3);
  assert.equal(new Set(f.calls().map((call) => call.cwd)).size, 3);
  assert.equal(f.read().walkthrough.review_tips.filter((tip) => tip.investigationState === "complete").length, 3, JSON.stringify(f.read().walkthrough.review_tips));
});

test("setup failure is blocked rather than resolved, clears pending and retries on the next run", async (t) => {
  const f = fixture(t, "failure");
  await f.run();
  let tip = f.read().walkthrough.review_tips[0];
  assert.equal(tip.status, "info");
  assert.equal(tip.pending, undefined);
  assert.equal(tip.resolved, false);
  assert.equal(tip.investigationState, "blocked");
  assert.match(tip.finding, /not logged in/);
  assert.equal(f.calls().length, 1);
  assert.equal(existsSync(f.calls()[0].cwd), false);
  await f.run();
  assert.equal(f.calls().length, 2);
});

test("duplicate resolver processes perform only one full-code investigation", async (t) => {
  const f = fixture(t, "slow");
  await Promise.all([f.run(), f.run(), f.run()]);
  assert.equal(f.calls().length, 1);
});

test("regeneration during investigation discards old results", async (t) => {
  const f = fixture(t, "slow");
  const first = f.run();
  for (let attempt = 0; !existsSync(`${f.record}.started`) && attempt < 100; attempt++) await pause(10);
  assert.equal(existsSync(`${f.record}.started`), true);
  const newer = structuredClone(f.content); newer.meta.generationId = "second-generation";
  await writeReviewFile(f.jsonPath, newer);
  await first;
  assert.deepEqual(f.read(), newer);
  assert.equal(f.calls().length, 1);
});

test("invalid verdicts and timeouts remain blocked and clean disposable worktrees", async (t) => {
  for (const scenario of ["invalid", "timeout"]) {
    const f = fixture(t, scenario);
    await f.run();
    const tip = f.read().walkthrough.review_tips[0];
    assert.equal(tip.investigationState, "blocked");
    assert.equal(tip.resolved, false);
    assert.equal(tip.pending, undefined);
    assert.equal(existsSync(f.calls()[0].cwd), false);
  }
});

test("missing local checks get at most one further attempt before a retryable blocked result", async (t) => {
  const f = fixture(t, "info");
  await f.run();
  assert.equal(f.calls().length, 2);
  assert.equal(f.read().walkthrough.review_tips[0].investigationState, "blocked");
  assert.match(f.calls()[1].prompt, /one final attempt/);
});
