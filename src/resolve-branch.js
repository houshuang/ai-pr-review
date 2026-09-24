/**
 * Resolve a bare branch name to a GitHub PR.
 *
 * `review sh/my-branch` should just work: we look the branch up in the repo you
 * are standing in and in the repos this tool generated walkthroughs for most
 * recently, then fall back to a global GitHub PR search.
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { exec as execCb, execSync } from "child_process";
import { promisify } from "util";
import { resolve } from "path";

const execAsync = promisify(execCb);

// meta is the first object written into each walkthrough JSON, so its fields
// land well inside the first kilobyte — no need to parse multi-MB files.
const META_BYTES = 1024;
const MAX_REPOS = 6;
const STATE_RANK = { OPEN: 0, MERGED: 1, CLOSED: 2 };

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Anything that isn't a flag, a URL, or a path is treated as a branch name. */
export function looksLikeBranchName(arg) {
  if (!arg || arg.startsWith("-")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return false;
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(arg)) return false; // scheme-less PR URL
  return /^[\w][\w./+-]*$/.test(arg);
}

function readMetaHead(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(META_BYTES);
    const bytes = readSync(fd, buf, 0, META_BYTES, 0);
    const head = buf.subarray(0, bytes).toString("utf-8");
    const str = (key) => head.match(new RegExp(`"${key}":\\s*"([^"]*)"`))?.[1] || null;
    const owner = str("owner");
    const repo = str("repo");
    if (!owner || !repo) return null;
    return { nameWithOwner: `${owner}/${repo}`, headBranch: str("headBranch") };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function repoFromGitRemote(cwd) {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

/**
 * Candidate repos, best guess first: the repo you're standing in, then repos
 * whose last walkthrough was for this very branch, then plain recency.
 */
export function recentRepos({ cwd, walkthroughsDir, branch, limit = MAX_REPOS }) {
  const ordered = [];
  const seen = new Set();
  const add = (r) => {
    if (r && !seen.has(r)) {
      seen.add(r);
      ordered.push(r);
    }
  };

  add(repoFromGitRemote(cwd));

  let metas = [];
  try {
    metas = readdirSync(walkthroughsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const path = resolve(walkthroughsDir, f);
        try {
          return { path, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((entry) => readMetaHead(entry.path))
      .filter(Boolean);
  } catch {
    metas = [];
  }

  for (const meta of metas) {
    if (meta.headBranch === branch) add(meta.nameWithOwner);
  }
  for (const meta of metas) add(meta.nameWithOwner);

  return ordered.slice(0, limit);
}

function normalize(pr, nameWithOwner) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: String(pr.state || "").toUpperCase(),
    updatedAt: pr.updatedAt,
    nameWithOwner: nameWithOwner || pr.repository?.nameWithOwner || null,
  };
}

async function prsInRepo(nameWithOwner, branch) {
  const { stdout } = await execAsync(
    `gh pr list --repo ${shq(nameWithOwner)} --head ${shq(branch)} --state all --limit 10 ` +
      `--json number,title,url,state,updatedAt`,
    { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 }
  );
  return JSON.parse(stdout || "[]").map((pr) => normalize(pr, nameWithOwner));
}

async function prsAnywhere(branch) {
  const { stdout } = await execAsync(
    `gh search prs --head ${shq(branch)} --limit 10 --json number,title,url,state,updatedAt,repository`,
    { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 }
  );
  return JSON.parse(stdout || "[]").map((pr) => normalize(pr));
}

function rank(matches) {
  return matches.sort(
    (a, b) =>
      (STATE_RANK[a.state] ?? 3) - (STATE_RANK[b.state] ?? 3) ||
      new Date(b.updatedAt) - new Date(a.updatedAt)
  );
}

/**
 * @returns {{ pr: object|null, others: object[], searched: string[], allQueriesFailed: boolean }}
 */
export async function resolveBranchToPR(branch, { cwd, walkthroughsDir }) {
  const searched = recentRepos({ cwd, walkthroughsDir, branch });

  const settled = await Promise.all(
    searched.map((repo) => prsInRepo(repo, branch).catch(() => null))
  );
  const failures = settled.filter((r) => r === null).length;
  let matches = settled.filter(Boolean).flat();

  if (matches.length === 0) {
    // Branch may live in a repo we've never reviewed here.
    matches = await prsAnywhere(branch).catch(() => []);
  }

  const byUrl = new Map();
  for (const pr of matches) if (!byUrl.has(pr.url)) byUrl.set(pr.url, pr);
  const ranked = rank([...byUrl.values()]);

  return {
    pr: ranked[0] || null,
    others: ranked.slice(1),
    searched,
    allQueriesFailed: searched.length > 0 && failures === searched.length,
  };
}
