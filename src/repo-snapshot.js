import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, realpathSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

export async function createInvestigationWorkspace(meta, invokingPath, cacheDir = defaultCache, { diff = "", remoteUrl } = {}) {
  const unpinned = !meta.headSha;
  const pinnedMeta = unpinned ? { ...meta, headSha: git(["rev-parse", "HEAD"], invokingPath) } : meta;
  const snapshot = await ensureRepoSnapshot(pinnedMeta, invokingPath, cacheDir, { remoteUrl });
  const common = git(["rev-parse", "--git-common-dir"], snapshot.path);
  const objects = resolve(snapshot.path, common);
  const root = dirname(objects);
  const scratchRoot = resolve(root, "investigations");
  mkdirSync(scratchRoot, { recursive: true });
  const path = resolve(scratchRoot, randomUUID());
  const locked = async (action) => {
    const release = await acquireFileLock(resolve(root, "snapshot.lock"), { timeoutMs: 150000 });
    if (!release) throw new Error("Timed out waiting for investigation worktree maintenance");
    try { return action(); } finally { await release(); }
  };
  const ownerPath = `${path}.owner`;
  await locked(() => {
    for (const name of readdirSync(scratchRoot).filter((name) => /^[a-f0-9-]+\.owner$/.test(name))) {
      const marker = resolve(scratchRoot, name);
      const pid = Number(readFileSync(marker, "utf8"));
      if (!Number.isInteger(pid) || pid < 1) continue;
      try { process.kill(pid, 0); }
      catch (error) {
        if (error.code !== "ESRCH") continue;
        const abandoned = marker.slice(0, -6);
        if (existsSync(abandoned)) git(["worktree", "remove", "--force", abandoned], objects);
        unlinkSync(marker);
      }
    }
    writeFileSync(ownerPath, String(process.pid), { flag: "wx" });
    try { git(["worktree", "add", "--detach", path, pinnedMeta.headSha], objects); }
    catch (error) { unlinkSync(ownerPath); throw error; }
  });
  const cleanup = () => locked(() => {
    git(["worktree", "remove", "--force", path], objects);
    unlinkSync(ownerPath);
  });
  let provenance = snapshot.provenance;
  try {
    if (unpinned) {
      if (!diff.trim()) throw new Error("Patch has no diff to reconstruct in a worktree");
      const apply = (args) => execFileSync("git", ["apply", ...args, "-"], { ...options, cwd: path, input: diff, stdio: ["pipe", "pipe", "pipe"] });
      try {
        apply(["--check"]);
        apply([]);
        provenance = `patch applied to invoking committed HEAD ${pinnedMeta.headSha}; original patch base is unknown`;
      } catch (forwardError) {
        try { apply(["--reverse", "--check"]); }
        catch { throw new Error(`Patch cannot be reconstructed against invoking committed HEAD: ${forwardError.stderr?.toString().trim() || forwardError.message}`); }
        provenance = `invoking committed HEAD ${pinnedMeta.headSha} already contains patch; original patch base is unknown`;
      }
    }
    return { path, provenance, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
