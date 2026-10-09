import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonBody, HttpError, validSlug, sendError } from "./server-http.js";
import { walkthroughIdentity } from "./walkthrough-poll.js";
import { chatMessages } from "./chat-context.js";
import { acquireFileLock } from "./review-storage.js";
import { hash } from "./cache-policy.js";
import { getTaskConfig } from "./models.js";
import {
  explanationScope,
  explainRepository,
  repositoryContext,
  readSource,
  repositoryCache,
  EXPLANATION_VERSION,
} from "./repository-explanation.js";

export async function loadReview(root, { slug = "walkthrough-data", generationId }) {
  if (!validSlug(slug) || typeof generationId !== "string")
    throw new HttpError(400, "Review slug and generation are required");
  let review;
  try {
    review = JSON.parse(
      await readFile(
        resolve(
          root,
          "public",
          slug === "walkthrough-data" ? "walkthrough-data.json" : `walkthroughs/${slug}.json`,
        ),
        "utf8",
      ),
    );
  } catch (error) {
    throw new HttpError(error.code === "ENOENT" ? 404 : 503, "Walkthrough unavailable");
  }
  if (walkthroughIdentity(review) !== generationId)
    throw new HttpError(409, "Walkthrough changed. Reload before generating an explanation.");
  return review;
}

export function explanationKey(review, scope) {
  return hash(
    JSON.stringify({
      generation: walkthroughIdentity(review),
      head: review.meta.headSha,
      base: review.meta.baseSha,
      scope,
      version: EXPLANATION_VERSION,
      task: getTaskConfig("codex", "explanation"),
    }),
  );
}

async function readSavedDescription(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      !value ||
      typeof value.title !== "string" ||
      !value.title.trim() ||
      typeof value.markdown !== "string" ||
      !value.markdown.trim() ||
      !value.scope ||
      typeof value.generationId !== "string" ||
      !Array.isArray(value.references) ||
      !value.references.every(
        (ref) =>
          ref &&
          typeof ref.path === "string" &&
          Number.isSafeInteger(ref.line) &&
          ref.line > 0 &&
          ["head", "base"].includes(ref.revision),
      )
    )
      return null;
    return value;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function savedExplanations(root, review) {
  const { readdir } = await import("node:fs/promises");
  const dir = resolve(root, ".cache/explanations");
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const results = [];
  for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    const result = await readSavedDescription(resolve(dir, name));
    if (!result) continue;
    if (
      result.generationId === walkthroughIdentity(review) &&
      name === `${explanationKey(review, result.scope)}.json`
    )
      results.push(result);
  }
  return results;
}

export function createExplanationHandler({
  root,
  explain = explainRepository,
  context = repositoryContext,
  source = readSource,
  timeout = 15 * 60_000,
}) {
  const jobs = new Map();
  const dir = resolve(root, ".cache/explanations");
  const cached = (key) => readSavedDescription(resolve(dir, `${key}.json`));
  return async (req, res) => {
    try {
      if (req.method !== "POST") throw new HttpError(405, "POST only");
      const body = await readJsonBody(req);
      const review = await loadReview(root, body);
      const selection = explanationScope(review, body.scope);
      const key = explanationKey(review, selection.scope);
      const action = body.action || "load";
      let result;
      if (action === "source") {
        const ctx = await context(review.meta, review.diff, repositoryCache(root));
        try {
          result = await source(ctx, body.reference || {});
        } finally {
          await ctx.cleanup();
        }
      } else if (action === "cancel") {
        jobs.get(key)?.abort?.abort();
        result = { status: "cancelled" };
      } else if (action === "followup") {
        const messages = chatMessages(body);
        const prior = await cached(key);
        if (!prior) throw new HttpError(400, "Generate the explanation before asking a follow-up");
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), timeout);
        const close = () => {
          if (!res.writableEnded) abort.abort();
        };
        res.on("close", close);
        try {
          result = await explain(review, selection.scope, {
            cacheDir: repositoryCache(root),
            signal: abort.signal,
            message: body.message,
            history: [{ role: "assistant", content: prior.markdown.slice(0, 30_000) }, ...messages],
          });
          await loadReview(root, body);
        } finally {
          clearTimeout(timer);
          res.off("close", close);
        }
      } else if (action === "load" || action === "generate") {
        const existing = jobs.get(key);
        const saved = await cached(key);
        if (existing?.status === "running") result = { status: "running" };
        else if (action === "load")
          result =
            existing?.status === "failed"
              ? { status: "failed", error: existing.error }
              : saved
                ? { status: "complete", result: saved }
                : { status: "idle" };
        else if (saved && !body.force) result = { status: "complete", result: saved };
        else {
          if ([...jobs.values()].filter((job) => job.status === "running").length >= 2)
            throw new HttpError(
              429,
              "Two explanations are already running. Try again when one finishes.",
            );
          const abort = new AbortController();
          const job = { status: "running", abort };
          jobs.set(key, job);
          const timer = setTimeout(() => abort.abort(), timeout);
          const run = async () => {
            let release;
            try {
              await mkdir(dir, { recursive: true });
              release = await acquireFileLock(resolve(dir, `${key}.lock`), {
                timeoutMs: timeout,
                signal: abort.signal,
              });
              if (!release || abort.signal.aborted)
                throw new Error("Explanation cancelled or timed out");
              const saved = await cached(key);
              const generated =
                saved && !body.force
                  ? saved
                  : await explain(review, selection.scope, {
                      cacheDir: repositoryCache(root),
                      signal: abort.signal,
                    });
              await loadReview(root, body);
              if (abort.signal.aborted) throw new Error("Explanation cancelled or timed out");
              const output = {
                ...generated,
                generationId: walkthroughIdentity(review),
                headSha: review.meta.headSha,
                baseSha: review.meta.baseSha,
                scope: selection.scope,
              };
              const temporary = resolve(dir, `${key}.${randomUUID()}.tmp`);
              await writeFile(temporary, JSON.stringify(output, null, 2));
              await rename(temporary, resolve(dir, `${key}.json`));
              job.status = "complete";
            } catch (error) {
              job.status = "failed";
              job.error = error.message;
            } finally {
              clearTimeout(timer);
              await release?.();
            }
          };
          void run().catch((error) => {
            job.status = "failed";
            job.error = error.message;
          });
          result = { status: "running" };
        }
      } else throw new HttpError(400, "Unknown explanation action");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(result));
    } catch (error) {
      sendError(res, error);
    }
  };
}
