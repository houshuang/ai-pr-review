import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  explainRepository,
  repositoryContext,
  readSource,
  explanationScope,
} from "../src/repository-explanation.js";

export function repositoryFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "explanation-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(root, "resolver.js"), 'export const label = uri => "Speaker 1";\n');
  writeFileSync(
    join(root, "caller.js"),
    'import { label } from "./resolver.js";\nexport const render = uri => label(uri);\n',
  );
  git("add", ".");
  git("commit", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");
  writeFileSync(join(root, "resolver.js"), 'export const label = uri => "Unknown " + uri;\n');
  git("add", ".");
  git("commit", "-m", "change");
  const headSha = git("rev-parse", "HEAD");
  const diff = git("diff", baseSha, headSha);
  writeFileSync(join(root, "caller.js"), "dirty caller that must never become review evidence");
  return {
    root,
    git,
    review: {
      meta: {
        generationId: "g1",
        source: "local",
        title: "Stable identities",
        baseSha,
        headSha,
        repositoryPath: root,
      },
      diff,
      walkthrough: {
        title: "Stable identities",
        overview: "Identity must survive reordered arrivals",
        sections: [
          {
            id: "identity",
            title: "Allocate identities",
            narrative: "Explain stability",
            hunks: [{ file: "resolver.js", startLine: 1, endLine: 1 }],
          },
        ],
        file_map: [{ path: "resolver.js" }],
      },
    },
  };
}

test("deep dives inspect exact head and base, including unchanged callers, and preserve dirty source", async (t) => {
  const { root, review, git } = repositoryFixture(t);
  const status = git("status", "--porcelain");
  const result = await explainRepository(
    review,
    { kind: "section", id: "identity" },
    {
      cacheDir: join(root, "cache"),
      runner: async (options) => {
        assert.equal(options.task, "explanation");
        assert.match(options.systemPrompt, /intermediate state/);
        assert.match(options.systemPrompt, /inferred rationale/);
        assert.match(options.userPrompt, /Files to start from: resolver.js/);
        assert.match(readFileSync(join(options.cwd, "caller.js"), "utf8"), /import \{ label \}/);
        const base = options.userPrompt.match(/Base worktree: (.+)\n/)[1];
        assert.match(readFileSync(join(base, "resolver.js"), "utf8"), /Speaker 1/);
        return JSON.stringify({
          title: "Stable identity",
          markdown: "The identity boundary is resolver.js:1. caller.js:2 consumes it.",
          references: [
            { path: "resolver.js", line: 1, revision: "base" },
            { path: "caller.js", line: 2, revision: "head" },
          ],
        });
      },
    },
  );
  assert.match(result.provenance, new RegExp(review.meta.headSha));
  assert.equal(result.references.length, 2);
  assert.equal(git("status", "--porcelain"), status + "\n?? cache/");
  assert.equal(
    readFileSync(join(root, "caller.js"), "utf8"),
    "dirty caller that must never become review evidence",
  );
});

test("source viewing reads unchanged files at the chosen revision and rejects traversal and fabricated citations", async (t) => {
  const { root, review } = repositoryFixture(t);
  const context = await repositoryContext(review.meta, review.diff, join(root, "cache"));
  assert.match(
    (await readSource(context, { path: "resolver.js", line: 1, revision: "base" })).text,
    /Speaker 1/,
  );
  assert.match((await readSource(context, { path: "caller.js", line: 2 })).text, /render/);
  await assert.rejects(
    readSource(context, { path: "../caller.js" }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    readSource(context, { path: "/etc/passwd" }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    readSource(context, { path: "resolver.js", line: 999 }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    readSource(context, { path: "missing.js" }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    explainRepository(
      review,
      { kind: "pr" },
      {
        cacheDir: join(root, "cache"),
        runner: async () =>
          JSON.stringify({
            title: "Fabricated",
            markdown: "Missing",
            references: [{ path: "missing.js", line: 1, revision: "head" }],
          }),
      },
    ),
    (error) => error.status === 404,
  );
});

test("full source viewing includes the complete pinned file and refuses invalid display modes", async t => {
  const { root, review } = repositoryFixture(t);
  const context = await repositoryContext(review.meta, review.diff, join(root, 'cache'));
  try {
    const full = await readSource(context, { path: 'caller.js', line: 2, full: true });
    assert.equal(full.start, 1);
    assert.match(full.text, /1: import/);
    await assert.rejects(readSource(context, { path: 'caller.js', full: 'yes' }), /Invalid source display mode/);
  } finally { await context.cleanup(); }
});

test("short filenames resolve only when unambiguous in the recorded repository", async t => {
  const { root, review, git } = repositoryFixture(t);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'unique.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'nested', 'caller.js'), 'another caller\n');
  git('add', 'nested'); git('commit', '-m', 'source lookup fixture');
  review.meta.headSha = git('rev-parse', 'HEAD');
  const context = await repositoryContext(review.meta, review.diff, join(root, 'cache'));
  try {
    assert.equal((await readSource(context, { path: 'unique.ts' })).path, 'nested/unique.ts');
    await assert.rejects(readSource(context, { path: 'caller.js' }), /Ambiguous filename/);
  } finally { await context.cleanup(); }
});

test("scope comes from stored review and cannot target an unrelated file or section", () => {
  const review = {
    walkthrough: { title: "Change", sections: [{ id: "a", title: "A", hunks: [] }] },
    diff: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n",
  };
  assert.deepEqual(explanationScope(review, { kind: "section", id: "a", title: "forged" }).scope, {
    kind: "section",
    id: "a",
  });
  assert.equal(explanationScope(review, { kind: "file", path: "a.js" }).title, "a.js");
  assert.throws(
    () => explanationScope(review, { kind: "file", path: "secret" }),
    (error) => error.status === 404,
  );
  assert.throws(
    () => explanationScope(review, { kind: "section", id: "missing" }),
    (error) => error.status === 404,
  );
});
