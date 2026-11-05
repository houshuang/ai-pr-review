import { test } from "node:test";
import assert from "node:assert/strict";
import { inputHash, canReuseCache, canPatchCache, configFingerprint } from "../src/cache-policy.js";

const data = { source:"local", repositoryPath:"/repo", provenance:"local:/repo:base:head", title:"feature",body:"commit",baseSha:"base",headSha:"head",headBranch:"feature",diff:"diff" };
const fingerprint = configFingerprint("codex", {generation:{model:"gpt-6.1-sol",effort:"medium"}});
const cached = { meta:{...data,generationId:"generation",inputHash:inputHash(data),configFingerprint:fingerprint} };

test("cache requires exact content, base, model settings and generation identity", () => {
  assert.equal(canReuseCache(cached,data,fingerprint),true);
  for (const changed of [{...data,diff:"changed"},{...data,baseSha:"new-base"},{...data,title:"new title"}]) assert.equal(canReuseCache(cached,changed,fingerprint),false);
  assert.equal(canReuseCache(cached,data,"new-model"),false);
  assert.equal(canReuseCache({meta:{...cached.meta,generationId:null}},data,fingerprint),false);
});

test("a GitHub target branch moving does not change the reviewed input", () => {
  const github = { ...data, source:"github", repositoryPath:null, provenance:"github:o/r#1:base:head" };
  const saved = { meta:{...github,generationId:"generation",inputHash:inputHash(github),configFingerprint:fingerprint} };
  const moved = { ...github, baseSha:"new-base", provenance:"github:o/r#1:new-base:head" };
  assert.equal(canReuseCache(saved,moved,fingerprint),true);
  assert.equal(canReuseCache(saved,{...moved,diff:"changed"},fingerprint),false);
  assert.equal(canReuseCache(saved,{...moved,headSha:"next"},fingerprint),false);
  assert.equal(canPatchCache(saved,{...moved,headSha:"next"},fingerprint),true);
});

test("incremental patch cannot cross repositories, bases or model settings", () => {
  assert.equal(canPatchCache(cached,{...data,headSha:"next"},fingerprint),true);
  assert.equal(canPatchCache(cached,{...data,repositoryPath:"/other"},fingerprint),false);
  assert.equal(canPatchCache(cached,{...data,baseSha:"new"},fingerprint),false);
  assert.equal(canPatchCache(cached,data,"other-settings"),false);
});
