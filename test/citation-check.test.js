import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citationProblems, repairCitations, gitRevisionReader } from "../src/citation-check.js";

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

test("short and partial citations become the one file they can name; the rest stay for the check", async () => {
  const repo = await repository();
  try {
    const readers = { head: gitRevisionReader(repo.root, "HEAD"), base: gitRevisionReader(repo.root, repo.base) };
    const section = (narrative, file) => ({
      overview: "Overview cites types.ts:1, a/types.ts:2 and src/unique.ts:3-9.",
      sections: [{ id: "one", narrative, hunks: [{ file, annotation: "Changes types.ts:1." }], callouts: [{ label: "Check", text: "Compare types.ts:3 with base unique.ts:2-5." }] }],
      review_tips: ["Read types.ts:2-3.", { tip: "Then https://example.test/types.ts:1 and unique.ts:9." }],
    });
    const walkthrough = section("The narrative cites types.ts:1.", "src/b/types.ts");
    assert.equal(await repairCitations(walkthrough, readers, ["src/unique.ts"]), 7);
    // Only src/a/types.ts is long enough for lines 2 and 3; line 1 fits both, so the file the section shows decides.
    assert.equal(walkthrough.overview, "Overview cites types.ts:1, src/a/types.ts:2 and src/unique.ts:3-4.");
    assert.equal(walkthrough.sections[0].narrative, "The narrative cites src/b/types.ts:1.");
    assert.equal(walkthrough.sections[0].hunks[0].annotation, "Changes src/b/types.ts:1.");
    assert.equal(walkthrough.sections[0].callouts[0].text, "Compare src/a/types.ts:3 with base src/unique.ts:2.");
    assert.equal(walkthrough.review_tips[0], "Read src/a/types.ts:2-3.");
    assert.equal(walkthrough.review_tips[1].tip, "Then https://example.test/types.ts:1 and unique.ts:9.");
    assert.deepEqual((await citationProblems(walkthrough, readers)).map((problem) => problem.cited), ["types.ts:1", "unique.ts:9"]);

    const changed = { overview: "See types.ts:1 and unique.ts:4.", sections: [], review_tips: [] };
    assert.equal(await repairCitations(changed, readers, ["src/a/types.ts"]), 1);
    assert.equal(changed.overview, "See src/a/types.ts:1 and unique.ts:4.");
    assert.equal(await repairCitations(changed, readers, ["src/a/types.ts"]), 0);
  } finally { await repo.cleanup(); }
});
