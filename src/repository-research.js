import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { hash, inputHash } from "./cache-policy.js";
import { getTaskConfig } from "./models.js";
import { acquireFileLock } from "./review-storage.js";
import { explainRepository, repositoryContext, readSource } from "./repository-explanation.js";
import { withTaskProgress } from "./task-progress.js";

export const RESEARCH_VERSION = 2;
export function researchPlan(review) {
  const files = review.walkthrough.file_map.map((file) => file.path);
  if (files.length < 6) return [{ label: "Repository research", focus: null }];
  const verification = files.filter((path) =>
    /(?:^|\/)(?:__tests__|tests?|docs)(?:\/|$)|\.(?:test|spec)\.|\.(?:md|mdx)$/.test(path),
  );
  const implementation = files.filter((path) => !verification.includes(path));
  if (!implementation.length || !verification.length)
    return [{ label: "Repository research", focus: null }];
  return [
    {
      label: "Implementation research",
      focus: {
        files: implementation,
        instruction:
          "Own the explanation of structural changes, algorithms, lifecycle, storage and unchanged callers. Trace a concrete input and intermediate state. Explain alternatives and why the boundaries are necessary. Follow dependencies anywhere in the repository. Leave detailed test-by-test assessment to the other research pass. Keep under 2500 words and choose at most 60 essential references.",
      },
    },
    {
      label: "Invariant and test research",
      focus: {
        files: verification,
        instruction:
          "Own the assessment of invariants, failure modes, edge cases, compatibility and what the tests actually establish. Inspect implementations to verify the tests and challenge comments or PR claims. Distinguish test assertions from observed execution. Explain remaining risks and cross-file interactions. Leave the main algorithm tutorial to the other research pass. Keep under 1800 words and choose at most 60 essential references.",
      },
    },
  ];
}

export function researchKey(review) {
  return hash(
    JSON.stringify({
      input: inputHash({ ...review.meta, diff: review.diff }),
      repositoryPath: review.meta.repositoryPath || null,
      diffBaseSha: review.meta.diffBaseSha || null,
      diff: hash(review.diff),
      version: RESEARCH_VERSION,
      task: getTaskConfig("codex", "research"),
    }),
  );
}

export async function researchRepository(
  review,
  {
    cacheDir,
    signal,
    report = console.log,
    explain = explainRepository,
    prepare = repositoryContext,
    verify = readSource,
  } = {},
) {
  const context = await prepare(review.meta, review.diff, cacheDir);
  const dir = resolve(cacheDir, "../research");
  const key = researchKey(review);
  const path = resolve(dir, `${key}.json`);
  let release;
  try {
    release = await acquireFileLock(resolve(dir, `${key}.lock`), {
      signal,
      timeoutMs: 15 * 60_000,
    });
    if (!release) throw new Error("Research cancelled or timed out waiting for another run");
    let cached;
    try {
      cached = JSON.parse(await readFile(path, "utf8"));
      if (
        !cached ||
        cached.version !== RESEARCH_VERSION ||
        cached.key !== key ||
        typeof cached.markdown !== "string" ||
        !cached.markdown.trim() ||
        !Array.isArray(cached.references) ||
        !cached.references.every(
          (ref) =>
            ref &&
            typeof ref.path === "string" &&
            Number.isSafeInteger(ref.line) &&
            ref.line > 0 &&
            ["head", "base"].includes(ref.revision),
        )
      )
        cached = null;
      if (cached) for (const reference of cached.references) await verify(context, reference);
    } catch (error) {
      if (
        error.code === "ENOENT" ||
        error instanceof SyntaxError ||
        error.status === 400 ||
        error.status === 404
      )
        cached = null;
      else throw error;
    }
    if (cached) {
      report("Reusing completed repository research at the same revisions and configuration.");
      return cached;
    }
    const plan = researchPlan(review);
    report(
      plan.length > 1
        ? "Researching implementation and invariants concurrently (2 read-only passes)."
        : "Researching repository in one read-only pass.",
    );
    const passes = await Promise.allSettled(
      plan.map((pass) =>
        withTaskProgress(
          pass.label,
          (onActivity) =>
            explain(
              review,
              { kind: "pr" },
              { research: true, focus: pass.focus, context, cacheDir, signal, onActivity },
            ),
          { report },
        ),
      ),
    );
    const failure = passes.find((pass) => pass.status === "rejected");
    if (failure) throw failure.reason;
    if (signal?.aborted) throw new Error("Research cancelled");
    const results = passes.map((pass) => pass.value);
    const references = [
      ...new Map(
        results
          .flatMap((result) => result.references)
          .map((ref) => [`${ref.revision}:${ref.path}:${ref.line}`, ref]),
      ).values(),
    ];
    const result = {
      title: "Repository research",
      markdown: results
        .map((result, index) => `## ${plan[index].label}\n\n${result.markdown}`)
        .join("\n\n"),
      references,
      provenance: context.head.provenance,
      baseProvenance: context.base?.provenance || null,
      generatedAt: new Date().toISOString(),
      version: RESEARCH_VERSION,
      key,
      passes: plan.length,
    };
    const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(result));
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return result;
  } finally {
    await release?.();
    await context.cleanup();
  }
}
