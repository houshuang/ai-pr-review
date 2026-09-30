import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireFileLock } from "./review-storage.js";

const defaultCache = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "repos");
const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024, timeout: 120000 };
const git = (args, cwd) => execFileSync("git", args, { ...options, cwd }).trim();

export function safeRepoPath(repoPath, userPath) {
  const root = realpathSync(repoPath);
  const path = realpathSync(resolve(root, userPath));
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`Path escapes repo: ${userPath}`);
  return path;
}

export async function ensureRepoSnapshot(meta, invokingPath, cacheDir = defaultCache, { remoteUrl } = {}) {
  const github = Boolean(meta.owner && meta.repo && meta.number);
  // Patch files do not identify a commit; callers must describe this weaker provenance.
  if (!github && !meta.headSha) return { path: realpathSync(invokingPath), provenance: "invoking working directory; patch revision is unknown" };
  if (!/^[a-f0-9]{40,64}$/i.test(meta.headSha || "")) throw new Error("Review has no valid recorded head SHA");
  if (github && (![meta.owner, meta.repo].every((part) => /^[A-Za-z0-9_.-]+$/.test(part)) || !Number.isSafeInteger(meta.number) || meta.number < 1)) throw new Error("Invalid GitHub repository identity");
  const identity = github ? `${meta.owner}/${meta.repo}` : `local-${git(["rev-parse", "--show-toplevel"], invokingPath).replace(/[^A-Za-z0-9]/g, "_")}`;
  const root = resolve(cacheDir, identity);
  mkdirSync(root, { recursive: true });
  const release = await acquireFileLock(resolve(root, "snapshot.lock"), { timeoutMs: 150000 });
  if (!release) throw new Error("Timed out waiting for repository snapshot");
  try {
    const objects = resolve(root, "objects.git");
    const snapshot = resolve(root, meta.headSha.toLowerCase());
    const remote = github ? remoteUrl || `https://github.com/${meta.owner}/${meta.repo}.git` : invokingPath;
    if (!existsSync(objects)) {
      git(["init", "--bare", objects]);
      git(["remote", "add", "origin", remote], objects);
    }
    if (!existsSync(snapshot)) {
      // Fetch the recorded object, never the current PR ref: a later push must not change evidence.
      git(["fetch", "--depth", "1", remote, meta.headSha], objects);
      if (git(["rev-parse", "FETCH_HEAD"], objects).toLowerCase() !== meta.headSha.toLowerCase()) throw new Error("Fetched snapshot does not match review SHA");
      git(["worktree", "add", "--detach", snapshot, meta.headSha], objects);
    }
    if (git(["rev-parse", "HEAD"], snapshot).toLowerCase() !== meta.headSha.toLowerCase() || git(["status", "--porcelain"], snapshot)) throw new Error("Cached repository snapshot was modified");
    return { path: snapshot, provenance: `committed snapshot ${meta.headSha}` };
  } finally { await release(); }
}

export async function ensureGitHubSnapshot(meta, cacheDir = defaultCache) {
  if (!meta.owner || !meta.repo || !meta.number) throw new Error("GitHub identity is required");
  return (await ensureRepoSnapshot(meta, null, cacheDir)).path;
}
