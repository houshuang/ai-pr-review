import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireFileLock, updateReviewTip, writeReviewFile } from "./review-storage.js";

async function fixture(t, count = 2) {
  const directory = await mkdtemp(join(tmpdir(), "review-storage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "review.json");
  const meta = { generationId: "generation-one", owner: "owner", repo: "repo", number: 1, headSha: "a".repeat(40), provenance: "github:owner/repo#1" };
  const content = { meta, walkthrough: { review_tips: Array.from({ length: count }, (_, index) => ({ tip: `tip ${index}`, pending: true })) } };
  await writeReviewFile(path, content);
  return { path, meta, content };
}

test("old investigation cannot update a regenerated review, even with identical tip text", async (t) => {
  const { path, meta, content } = await fixture(t);
  const newer = structuredClone(content);
  newer.meta.generationId = "generation-two";
  await writeReviewFile(path, newer);
  assert.equal(await updateReviewTip(path, meta, content.walkthrough.review_tips[0], { status: "concern", finding: "old result", pending: false }), false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), newer);
});

test("updates require the full review identity and cannot resurrect a terminal tip", async (t) => {
  const { path, meta } = await fixture(t);
  for (const key of ["owner", "repo", "number", "headSha", "provenance"]) {
    assert.equal(await updateReviewTip(path, { ...meta, [key]: "different" }, "tip 0", { status: "info", pending: false }), false);
  }
  assert.equal(await updateReviewTip(path, meta, "tip 0", { status: "verified", finding: "complete", pending: false }), true);
  assert.equal(await updateReviewTip(path, meta, "tip 0", { status: "info", pending: true }), false);
  assert.equal(JSON.parse(await readFile(path, "utf8")).walkthrough.review_tips[0].finding, "complete");
  await assert.rejects(updateReviewTip(path, meta, "tip 1", { status: "invented", pending: false }), /Invalid tip status/);
});

test("refreshing cached metadata preserves terminal results written after the cache was read", async (t) => {
  const { path, meta, content } = await fixture(t);
  await updateReviewTip(path, meta, "tip 0", { status: "verified", finding: "completed while fetching comments", resolved: true, pending: false });
  content.comments = [{ body: "fresh comment" }];
  await writeReviewFile(path, content);
  const refreshed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(refreshed.walkthrough.review_tips[0].finding, "completed while fetching comments");
  assert.equal(refreshed.walkthrough.review_tips[0].pending, undefined);
  assert.deepEqual(refreshed.comments, content.comments);
  content.meta.generationId = "new-generation";
  await writeReviewFile(path, content);
  assert.equal(JSON.parse(await readFile(path, "utf8")).walkthrough.review_tips[0].pending, true);
});

test("separate resolver processes preserve all tip updates and readers always see complete JSON", async (t) => {
  const { path, meta } = await fixture(t, 12);
  const moduleUrl = new URL("./review-storage.js", import.meta.url).href;
  const workers = Array.from({ length: 12 }, (_, index) => {
    const script = `import {updateReviewTip} from ${JSON.stringify(moduleUrl)}; await updateReviewTip(${JSON.stringify(path)},${JSON.stringify(meta)},${JSON.stringify(`tip ${index}`)},{status:'verified',finding:'completed',pending:false});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", chunk => stderr += chunk);
    return once(child, "exit").then(([code]) => assert.equal(code, 0, stderr));
  });
  let completed = false;
  const all = Promise.all(workers).then(() => { completed = true; });
  while (!completed) JSON.parse(await readFile(path, "utf8"));
  await all;
  const tips = JSON.parse(await readFile(path, "utf8")).walkthrough.review_tips;
  assert.equal(tips.filter((tip) => tip.finding === "completed" && !tip.pending).length, 12);
});

test("live locks suppress duplicate work and dead process locks are recovered", async (t) => {
  const { path } = await fixture(t);
  const lockPath = `${path}.resolver.lock`;
  const release = await acquireFileLock(lockPath);
  assert.equal(await acquireFileLock(lockPath, { timeoutMs: 0 }), null);
  await release();
  await writeFile(lockPath, "2147483647:dead-process");
  const recovered = await acquireFileLock(lockPath, { timeoutMs: 0 });
  assert.equal(typeof recovered, "function");
  await recovered();
  await writeFile(`${lockPath}.gate`, "2147483647:dead-gate");
  const recoveredGate = await acquireFileLock(lockPath, { timeoutMs: 100 });
  assert.equal(typeof recoveredGate, "function");
  await recoveredGate();
});

test("generation replaces malformed prior cache JSON", async (t) => {
  const { path, content } = await fixture(t);
  await writeFile(path, '{"incomplete":');
  await writeReviewFile(path, content);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), content);
});

test("full-code lifecycle upgrades legacy tips, retries blocked checks, and never reopens completed investigations", async (t) => {
  const { path, meta } = await fixture(t);
  await updateReviewTip(path, meta, "tip 0", { status: "verified", resolved: true, pending: false });
  const start = { status: "info", pending: true, investigationState: "running" };
  assert.equal(await updateReviewTip(path, meta, "tip 0", start, { startInvestigation: true }), true);
  await updateReviewTip(path, meta, "tip 0", { status: "info", investigationState: "blocked", pending: false, resolved: false });
  assert.equal(await updateReviewTip(path, meta, "tip 0", start, { startInvestigation: true }), true);
  await updateReviewTip(path, meta, "tip 0", { status: "concern", investigationState: "complete", pending: false, resolved: true });
  assert.equal(await updateReviewTip(path, meta, "tip 0", start, { startInvestigation: true }), false);
});

test("cache retry queues unchanged eligible results before viewer startup and preserves concurrent progress", async (t) => {
  const { path, meta, content } = await fixture(t);
  await updateReviewTip(path, meta, "tip 0", { status: "info", investigationState: "blocked", resolved: false, pending: false, finding: "temporary outage" });
  let latest = JSON.parse(await readFile(path, "utf8"));
  const previous = structuredClone(latest.walkthrough.review_tips[0]);
  latest.walkthrough.review_tips[0].pending = true;
  await writeReviewFile(path, latest, { retryTips: [previous] });
  assert.equal(JSON.parse(await readFile(path, "utf8")).walkthrough.review_tips[0].pending, true);
  await updateReviewTip(path, meta, "tip 0", { status: "concern", investigationState: "complete", resolved: true, pending: false, finding: "full-code result" });
  await writeReviewFile(path, latest, { retryTips: [previous] });
  assert.equal(JSON.parse(await readFile(path, "utf8")).walkthrough.review_tips[0].finding, "full-code result");
  assert.equal(JSON.parse(await readFile(path, "utf8")).walkthrough.review_tips[0].pending, undefined);
  await updateReviewTip(path, meta, "tip 1", { status: "verified", resolved: true, pending: false, finding: "legacy diff result" });
  const oldLegacy = JSON.parse(await readFile(path, "utf8")).walkthrough.review_tips[1];
  content.walkthrough.review_tips[1] = { ...oldLegacy, pending: true };
  await writeReviewFile(path, content, { retryTips: [oldLegacy] });
  assert.equal(JSON.parse(await readFile(path, "utf8")).walkthrough.review_tips[1].pending, true);
});
