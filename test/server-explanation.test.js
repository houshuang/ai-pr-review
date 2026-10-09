import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, cp, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createExplanationHandler, savedExplanations } from "../src/server-explanation.js";

async function fixture(t, explain) {
  const root = await mkdtemp(join(tmpdir(), "explanation-server-"));
  await mkdir(join(root, "public/walkthroughs"), { recursive: true });
  const review = {
    meta: { generationId: "one", headSha: "a".repeat(40) },
    diff: "",
    walkthrough: { title: "PR", overview: "", sections: [], file_map: [] },
  };
  const save = () => writeFile(join(root, "public/walkthroughs/pr.json"), JSON.stringify(review));
  await save();
  const server = createServer(createExplanationHandler({ root, explain }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (action, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "pr",
        generationId: "one",
        scope: { kind: "pr" },
        action,
        ...extra,
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  const completed = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await call("load");
      if (value.body.status !== "running") return value.body;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Explanation never completed");
  };
  return { root, review, save, call, completed };
}
const result = {
  title: "Why",
  markdown: "Invariant and trace",
  references: [],
  scope: { kind: "pr" },
  provenance: "pinned",
  generatedAt: new Date().toISOString(),
};

test("jobs deduplicate, persist across reloads, support follow-ups and export the saved description", async (t) => {
  let calls = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async (review, scope, options) => {
    calls++;
    await gate;
    return options.message ? { ...result, markdown: "Follow-up: " + options.message } : result;
  });
  assert.equal((await f.call("generate")).body.status, "running");
  assert.equal((await f.call("generate")).body.status, "running");
  release();
  assert.equal((await f.completed()).status, "complete");
  assert.equal(calls, 1);
  assert.equal((await f.call("generate")).body.result.markdown, result.markdown);
  assert.equal(
    (await f.call("followup", { message: "Why this map?", history: [] })).body.markdown,
    "Follow-up: Why this map?",
  );
  assert.equal((await f.call("load")).body.result.markdown, result.markdown);
  assert.equal((await savedExplanations(f.root, f.review)).length, 1);
  const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await cp(join(toolRoot, "src"), join(f.root, "src"), { recursive: true });
  await cp(join(toolRoot, "package.json"), join(f.root, "package.json"));
  await symlink(join(toolRoot, "node_modules"), join(f.root, "node_modules"), "dir");
  const htmlPath = join(f.root, "review.html");
  execFileSync(
    process.execPath,
    [join(f.root, "src/export-static.js"), "pr", "--output", htmlPath],
    { cwd: f.root },
  );
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /Invariant and trace/);
  assert.doesNotMatch(html, /Follow-up: Why this map/);
  f.review.meta.generationId = "two";
  await f.save();
  assert.equal((await f.call("load")).status, 409);
  assert.equal((await savedExplanations(f.root, f.review)).length, 0);
});

test("regeneration during an agent run discards the stale result", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async () => {
    await gate;
    return result;
  });
  await f.call("generate");
  f.review.meta.generationId = "two";
  await f.save();
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    (
      await savedExplanations(f.root, {
        ...f.review,
        meta: { ...f.review.meta, generationId: "one" },
      })
    ).length,
    0,
  );
  assert.equal((await f.call("load")).status, 409);
});

test("scope validation and cancellation prevent unrelated or partial publication", async (t) => {
  const f = await fixture(t, async (review, scope, { signal }) => {
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error("cancelled"));
      else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  });
  assert.equal(
    (await f.call("generate", { scope: { kind: "file", path: "../secret" } })).status,
    404,
  );
  assert.equal((await f.call("generate", { slug: "../secret" })).status, 400);
  assert.equal((await f.call("followup", { message: "hi" })).status, 400);
  await f.call("generate");
  await f.call("cancel");
  assert.equal((await f.completed()).status, "failed");
  assert.equal((await savedExplanations(f.root, f.review)).length, 0);
});
