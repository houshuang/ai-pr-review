import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { writeReviewFile } from "./review-storage.js";

const src = dirname(fileURLToPath(import.meta.url));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function fixture(t, scenario = "normal") {
  const root = mkdtempSync(join(tmpdir(), "review-resolver-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  for (const name of ["resolve-info-tips.js", "review-storage.js", "repo-snapshot.js", "ai-provider.js", "models.js", "provider-config.js"]) {
    const source = process.env.REVIEW_TEST_PROVIDER_SOURCE && ["ai-provider.js", "models.js"].includes(name) ? process.env.REVIEW_TEST_PROVIDER_SOURCE : src;
    copyFileSync(join(source, name), join(root, "src", name));
  }
  symlinkSync(process.env.REVIEW_TEST_NODE_MODULES || resolve(src, "..", "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  mkdirSync(join(root, "public", "walkthroughs"), { recursive: true });
  mkdirSync(join(root, "bin"));
  const record = join(root, "calls");
  writeFileSync(join(root, "bin", "codex"), `#!/usr/bin/env node
import fs from 'node:fs';
let input = ''; process.stdin.on('data', data => input += data); process.stdin.on('end', async () => {
  const verification = input.includes('Tips to Verify');
  fs.appendFileSync(process.env.RECORD, (verification ? 'verification' : 'investigation') + '\\n');
  fs.writeFileSync(process.env.RECORD + '.started', 'started');
  if (process.env.SCENARIO === 'slow') await new Promise(done => setTimeout(done, 180));
  if (process.env.SCENARIO === 'failure') { process.stderr.write('ERROR: not logged in\\n'); process.exit(1); }
  let result;
  if (verification) result = {tips: [{tip: 'check code', status: 'info', finding: 'requires reading code'}]};
  else if (process.env.SCENARIO === 'invalid') result = {status: 'invented', finding: 'untrusted verdict'};
  else result = {status: 'concern', finding: fs.readFileSync('code.txt', 'utf8').trim()};
  const args = process.argv.slice(2); fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));
  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}) + '\\n');
});`, { mode: 0o755 });
  const repo = join(root, "repository");
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  writeFileSync(join(repo, "code.txt"), "evidence at recorded commit\n");
  git("add", "code.txt"); git("commit", "-m", "reviewed");
  const meta = { generationId: "first-generation", source: "local", headSha: git("rev-parse", "HEAD"), repositoryPath: repo, aiProvider: "codex" };
  writeFileSync(join(repo, "code.txt"), "dirty evidence must not be seen\n");
  const content = { meta, diff: "reviewed diff", walkthrough: { review_tips: [{ tip: "check code", status: "info", pending: true }] } };
  const jsonPath = join(root, "public", "walkthroughs", "review.json");
  writeFileSync(jsonPath, JSON.stringify(content));
  const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, RECORD: record, SCENARIO: scenario, REVIEW_AI_PROVIDER: "claude", ANTHROPIC_API_KEY: "" };
  const run = () => {
    const child = spawn(process.execPath, [join(root, "src", "resolve-info-tips.js"), "review", repo], { cwd: root, env, stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`))); });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    return done;
  };
  return { root, content, jsonPath, record, run, read: () => JSON.parse(readFileSync(jsonPath, "utf8")) };
}

test("resolver uses recorded provider and committed local evidence, then clears pending state", async (t) => {
  const f = fixture(t);
  await f.run();
  const tip = f.read().walkthrough.review_tips[0];
  assert.equal(tip.status, "concern");
  assert.equal(tip.finding, "evidence at recorded commit");
  assert.equal(tip.pending, undefined);
});

test("provider setup failure terminalizes pending tips and does not repeatedly invoke it", async (t) => {
  const f = fixture(t, "failure");
  await f.run();
  const tip = f.read().walkthrough.review_tips[0];
  assert.equal(tip.status, "info");
  assert.equal(tip.pending, undefined);
  assert.match(tip.finding, /not logged in/);
  assert.equal(readFileSync(f.record, "utf8").trim(), "verification");
});

test("duplicate resolver processes perform one verification and investigation", async (t) => {
  const f = fixture(t, "slow");
  await Promise.all([f.run(), f.run(), f.run()]);
  assert.deepEqual(readFileSync(f.record, "utf8").trim().split("\n"), ["verification", "investigation"]);
});

test("regeneration during verification discards its old results and investigation", async (t) => {
  const f = fixture(t, "slow");
  const first = f.run();
  for (let attempt = 0; !existsSync(`${f.record}.started`) && attempt < 100; attempt++) await pause(10);
  assert.equal(existsSync(`${f.record}.started`), true);
  const newer = structuredClone(f.content); newer.meta.generationId = "second-generation";
  await writeReviewFile(f.jsonPath, newer);
  await first;
  assert.deepEqual(f.read(), newer);
  assert.equal(readFileSync(f.record, "utf8").trim(), "verification");
});

test("unknown model statuses degrade to terminal info", async (t) => {
  const f = fixture(t, "invalid");
  await f.run();
  const tip = f.read().walkthrough.review_tips[0];
  assert.equal(tip.status, "info");
  assert.equal(tip.pending, undefined);
});
