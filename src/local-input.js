import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash } from "./cache-policy.js";

export function fetchLocalDiff(baseBranch = "main", cwd = process.env.REVIEW_ORIGINAL_CWD || process.cwd()) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 30000 }).trimEnd();
  const root = git("rev-parse", "--show-toplevel");
  const headSha = git("rev-parse", "HEAD");
  const baseSha = git("rev-parse", "--verify", `${baseBranch}^{commit}`);
  const mergeBase = git("merge-base", baseSha, headSha);
  const diff = git("diff", mergeBase, headSha);
  const stat = git("diff", "--shortstat", mergeBase, headSha);
  const statMatch = stat.match(/(\d+) files? changed(?:, (\d+) insertions?)?(?:, (\d+) deletions?)?/);
  const branch = git("branch", "--show-current");
  return {
    source: "local", title: branch || headSha.slice(0, 7), url: "", baseBranch, headBranch: branch,
    baseSha, diffBaseSha: mergeBase, headSha, provenance: `local:${root}:${baseSha}:${headSha}`, repositoryPath: root,
    additions: Number(statMatch?.[2] || 0), deletions: Number(statMatch?.[3] || 0), changedFiles: Number(statMatch?.[1] || 0),
    body: git("log", "--oneline", `${baseSha}..${headSha}`), files: [], diff,
  };
}

export function readDiffFile(path, cwd = process.env.REVIEW_ORIGINAL_CWD || process.cwd()) {
  if (!path) throw new Error("--diff needs a patch file path");
  const absolutePath = resolve(cwd, path);
  const diff = readFileSync(absolutePath, "utf-8");
  return { source: "file", title: absolutePath, url: "", baseBranch: "unknown", headBranch: "unknown", baseSha: null, headSha: null,
    provenance: `file:${absolutePath}:${hash(diff)}`, additions: 0, deletions: 0, changedFiles: 0, body: "", files: [], repositoryPath: resolve(cwd), diff };
}
