import { createHash } from "node:crypto";

export const PROMPT_VERSION = 4;
export const hash = (value) => createHash("sha256").update(value).digest("hex");

export function configFingerprint(provider, tasks) {
  return hash(JSON.stringify({ provider, tasks, promptVersion: PROMPT_VERSION }));
}

export function inputHash(data) {
  return hash(JSON.stringify({ source: data.source, provenance: data.provenance, title: data.title, body: data.body, baseSha: data.baseSha ?? null, headSha: data.headSha ?? null, diff: data.diff }));
}

// GitHub reports the target branch tip as the PR's base, so it moves whenever unrelated PRs land; the diff already pins what is reviewed.
const ignoringTargetTip = (cached, data) => data.source === "github" && cached.meta.headSha === data.headSha
  ? { ...data, baseSha: cached.meta.baseSha, provenance: cached.meta.provenance }
  : data;

export function canReuseCache(cached, data, fingerprint) {
  return Boolean(cached?.meta?.generationId && cached.meta.configFingerprint === fingerprint && cached.meta.inputHash === inputHash(ignoringTargetTip(cached, data)));
}

export function canPatchCache(cached, data, fingerprint) {
  return Boolean(cached?.meta?.generationId && cached.meta.configFingerprint === fingerprint && cached.meta.source === data.source && cached.meta.repositoryPath === (data.repositoryPath || null) && cached.meta.headBranch === data.headBranch && (data.source === "github" || cached.meta.baseSha === data.baseSha) && cached.meta.headSha && data.headSha);
}
