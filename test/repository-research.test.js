import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { researchRepository, researchPlan, researchKey } from "../src/repository-research.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "repository-research-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [
    "algorithm.ts",
    "lifecycle.ts",
    "callers.ts",
    "algorithm.test.ts",
    "tests/integration.ts",
    "README.md",
  ];
  const review = {
    meta: {
      source: "local",
      title: "Algorithms",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
    },
    diff: "diff",
    walkthrough: { title: "Algorithms", file_map: paths.map((path) => ({ path })) },
  };
  let cleanups = 0;
  const context = {
    head: { path: root, provenance: "head" },
    base: { path: root, provenance: "base" },
    cleanup: async () => cleanups++,
  };
  const options = {
    cacheDir: join(root, "repos"),
    report: () => {},
    prepare: async () => context,
    verify: async () => {},
  };
  return { root, review, context, options, cleanups: () => cleanups };
}
const result = (focus) => ({
  title: "Research",
  markdown: focus.files.join(", "),
  references: [{ path: focus.files[0], line: 1, revision: "head" }],
});

test("two complementary passes overlap, share pinned evidence and cache their combined result", async (t) => {
  const f = await fixture(t);
  let started = 0,
    both,
    release;
  const ready = new Promise((resolve) => (both = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  const explain = async (review, scope, options) => {
    assert.equal(options.context, f.context);
    assert.equal(options.research, true);
    if (++started === 2) both();
    await gate;
    return result(options.focus);
  };
  const pending = researchRepository(f.review, { ...f.options, explain });
  await ready;
  assert.equal(started, 2);
  release();
  const research = await pending;
  assert.equal(research.passes, 2);
  assert.match(research.markdown, /Implementation research/);
  assert.match(research.markdown, /Invariant and test research/);
  assert.equal(research.references.length, 2);
  assert.equal(f.cleanups(), 1);
  const cached = await researchRepository(f.review, {
    ...f.options,
    explain: async () => assert.fail("must reuse research"),
  });
  assert.deepEqual(cached, research);
  assert.equal(f.cleanups(), 2);
});

test("research cache invalidates revisions, diff, instructions and research model settings", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { headSha: "c".repeat(40) },
    { baseSha: "c".repeat(40) },
    { body: "changed motivation" },
    { repositoryPath: "/another/repo" },
  ]) {
    assert.notEqual(
      researchKey({ ...f.review, meta: { ...f.review.meta, ...change } }),
      researchKey(f.review),
    );
  }
  assert.notEqual(researchKey({ ...f.review, diff: "different" }), researchKey(f.review));
  assert.notEqual(
    researchKey(f.review, f.context),
    researchKey(f.review, {
      ...f.context,
      head: { ...f.context.head, provenance: "patch against another HEAD" },
    }),
  );
  const previous = process.env.REVIEW_CODEX_RESEARCH_EFFORT;
  try {
    process.env.REVIEW_CODEX_RESEARCH_EFFORT = "medium";
    assert.notEqual(
      researchKey(f.review),
      (() => {
        process.env.REVIEW_CODEX_RESEARCH_EFFORT = "high";
        return researchKey(f.review);
      })(),
    );
  } finally {
    if (previous === undefined) delete process.env.REVIEW_CODEX_RESEARCH_EFFORT;
    else process.env.REVIEW_CODEX_RESEARCH_EFFORT = previous;
  }
});

test("failed or cancelled passes never publish a partial cache; malformed cache can recover", async (t) => {
  const f = await fixture(t);
  const fail = () =>
    researchRepository(f.review, {
      ...f.options,
      explain: async () => {
        throw new Error("research unavailable");
      },
    });
  await assert.rejects(fail(), /research unavailable/);
  let calls = 0;
  const explain = async (r, s, o) => {
    calls++;
    return result(o.focus);
  };
  const good = await researchRepository(f.review, { ...f.options, explain });
  assert.equal(calls, 2);
  const path = join(f.root, "research", `${good.key}.json`);
  await writeFile(path, '{"truncated":');
  await researchRepository(f.review, { ...f.options, explain });
  assert.equal(calls, 4);
  await writeFile(path, "null");
  const controller = new AbortController();
  await assert.rejects(
    researchRepository(f.review, {
      ...f.options,
      signal: controller.signal,
      explain: async (r, s, o) => {
        controller.abort();
        return result(o.focus);
      },
    }),
    /cancelled/,
  );
  await researchRepository(f.review, { ...f.options, explain });
  assert.equal(calls, 6);
});

test("small and homogeneous changes keep one pass, while partitioned files retain complete coverage", async (t) => {
  const f = await fixture(t);
  const plan = researchPlan(f.review);
  assert.deepEqual(
    new Set(plan.flatMap((pass) => pass.focus.files)),
    new Set(f.review.walkthrough.file_map.map((file) => file.path)),
  );
  assert.equal(
    researchPlan({ ...f.review, walkthrough: { file_map: [{ path: "simple.ts" }] } }).length,
    1,
  );
  assert.equal(
    researchPlan({
      ...f.review,
      walkthrough: { file_map: Array.from({ length: 7 }, (_, i) => ({ path: `source${i}.ts` })) },
    }).length,
    1,
  );
});
