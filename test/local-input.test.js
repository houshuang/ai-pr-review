import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLocalDiff, readDiffFile } from "../src/local-input.js";

test("local diff reads the invoking repository without changing branches or including dirty edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-local-"));
  const git = (...args) => execFileSync("git", args, {cwd:dir,encoding:"utf8"}).trim();
  try {
    git("init", "-b", "main"); git("config","user.name","Test"); git("config","user.email","test@example.com");
    writeFileSync(join(dir,"a.js"), "export const value = 1;\n"); git("add","a.js"); git("commit","-m","base");
    git("checkout","-b","feature"); writeFileSync(join(dir,"a.js"), "export const value = 2;\n"); git("add","a.js"); git("commit","-m","change");
    writeFileSync(join(dir,"a.js"), "export const value = 999;\n");
    const result = fetchLocalDiff("main",dir);
    assert.match(result.diff, /\+export const value = 2;/); assert.doesNotMatch(result.diff,/999/);
    assert.equal(result.headBranch,"feature"); assert.equal(result.headSha,git("rev-parse","HEAD"));
    assert.match(git("status","--porcelain"), /a.js/);
    assert.equal(result.repositoryPath,git("rev-parse","--show-toplevel"));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("relative patch paths resolve from invoking directory and have content-specific identity", () => {
  const dir = mkdtempSync(join(tmpdir(),"review-patch-"));
  try {
    writeFileSync(join(dir,"change.patch"), "old\n"); const first = readDiffFile("change.patch",dir);
    writeFileSync(join(dir,"change.patch"), "new\n"); const second = readDiffFile("change.patch",dir);
    assert.equal(second.diff,"new\n"); assert.notEqual(first.provenance,second.provenance);
    assert.throws(() => readDiffFile(undefined,dir), /needs a patch file/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
