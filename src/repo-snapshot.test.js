import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ensureRepoSnapshot, safeRepoPath } from "./repo-snapshot.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "review-snapshot-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "source");
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  writeFileSync(join(repo, "code.txt"), "reviewed commit\n");
  git("add", "code.txt"); git("commit", "-m", "reviewed");
  const oldSha = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "code.txt"), "newer commit\n");
  git("commit", "-am", "newer");
  const newSha = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "code.txt"), "dirty invoking checkout\n");
  return { directory, repo, git, oldSha, newSha, cache: join(directory, "cache") };
}

test("GitHub snapshots use the recorded SHA even when the invoking checkout is newer and dirty", async (t) => {
  const { repo, git, oldSha, newSha, cache } = fixture(t);
  const meta = { owner: "fixture", repo: "repo", number: 3, headSha: oldSha };
  const results = await Promise.all(Array.from({ length: 4 }, () => ensureRepoSnapshot(meta, repo, cache, { remoteUrl: repo })));
  assert.equal(new Set(results.map((result) => result.path)).size, 1);
  assert.equal(readFileSync(join(results[0].path, "code.txt"), "utf8"), "reviewed commit\n");
  const newer = await ensureRepoSnapshot({ ...meta, headSha: newSha }, repo, cache, { remoteUrl: repo });
  assert.notEqual(newer.path, results[0].path);
  assert.equal(readFileSync(join(newer.path, "code.txt"), "utf8"), "newer commit\n");
  assert.equal(readFileSync(join(results[0].path, "code.txt"), "utf8"), "reviewed commit\n");
  assert.equal(git("rev-parse", "HEAD"), newSha);
  assert.equal(readFileSync(join(repo, "code.txt"), "utf8"), "dirty invoking checkout\n");
});

test("local branch investigation excludes uncommitted edits; patch investigation labels weaker provenance", async (t) => {
  const { repo, oldSha, cache } = fixture(t);
  const snapshot = await ensureRepoSnapshot({ source: "local", headSha: oldSha }, repo, cache);
  assert.equal(readFileSync(join(snapshot.path, "code.txt"), "utf8"), "reviewed commit\n");
  const patch = await ensureRepoSnapshot({ source: "file" }, repo, cache);
  assert.equal(patch.path, realpathSync(repo));
  assert.match(patch.provenance, /revision is unknown/);
});

test("unavailable or modified snapshots fail rather than investigating another revision", async (t) => {
  const { repo, oldSha, cache } = fixture(t);
  const meta = { owner: "fixture", repo: "repo", number: 3, headSha: oldSha };
  await assert.rejects(ensureRepoSnapshot({ ...meta, headSha: "f".repeat(40) }, repo, cache, { remoteUrl: repo }));
  const snapshot = await ensureRepoSnapshot(meta, repo, cache, { remoteUrl: repo });
  writeFileSync(join(snapshot.path, "code.txt"), "corrupted snapshot");
  await assert.rejects(ensureRepoSnapshot(meta, repo, cache, { remoteUrl: repo }), /snapshot was modified/);
});

test("read tool refuses symlinks outside the repository, including prefix-sibling directories", (t) => {
  const { directory, repo } = fixture(t);
  const external = join(directory, "source-sibling");
  mkdirSync(external);
  writeFileSync(join(external, "secret"), "private");
  symlinkSync(join(external, "secret"), join(repo, "escape"));
  assert.throws(() => safeRepoPath(repo, "escape"), /escapes repo/);
  assert.throws(() => safeRepoPath(repo, "../source-sibling/secret"), /escapes repo/);
  assert.equal(safeRepoPath(repo, "code.txt"), realpathSync(join(repo, "code.txt")));
});
