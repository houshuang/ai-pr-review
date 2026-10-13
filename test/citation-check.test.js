import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citationProblems, gitRevisionReader } from "../src/citation-check.js";

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "citation-check-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  await mkdir(join(root, "src/a"), { recursive: true });
  await mkdir(join(root, "src/b"), { recursive: true });
  await writeFile(join(root, "src/a/types.ts"), "one\ntwo\nthree\n");
  await writeFile(join(root, "src/b/types.ts"), "one\n");
  await writeFile(join(root, "src/unique.ts"), "one\ntwo\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(root, "src/unique.ts"), "one\ntwo\nthree\nfour\n");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "head");
  return { root, base, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const walkthrough = (overview) => ({ overview, sections: [], review_tips: [] });

test("citations resolve like the source preview and are checked against the revision they name", async () => {
  const repo = await repository();
  try {
    const readers = { head: gitRevisionReader(repo.root, "HEAD"), base: gitRevisionReader(repo.root, repo.base) };
    const check = async (text) => (await citationProblems(walkthrough(text), readers)).map((problem) => problem.message);
    assert.deepEqual(await check("See src/a/types.ts:3, unique.ts:4 and base unique.ts:2."), []);
    assert.match((await check("See types.ts:1."))[0], /matches 2 files; cite the full path/);
    assert.match((await check("See a/types.ts:1."))[0], /is not a file at that revision/);
    assert.match((await check("See src/unique.ts:3-9."))[0], /past the end of src\/unique\.ts, which has 4 lines at the head/);
    assert.match((await check("See base src/unique.ts:4."))[0], /which has 2 lines at the base/);
    assert.deepEqual(await citationProblems(walkthrough("See base src/unique.ts:4."), { head: readers.head }), []);
  } finally { await repo.cleanup(); }
});
