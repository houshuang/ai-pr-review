import { createHash } from "node:crypto";

export const PROMPT_VERSION = 3;
export const hash = (value) => createHash("sha256").update(value).digest("hex");

export function configFingerprint(provider, tasks) {
  return hash(JSON.stringify({ provider, tasks, promptVersion: PROMPT_VERSION }));
}

export function inputHash(data) {
  return hash(JSON.stringify({ source: data.source, provenance: data.provenance, title: data.title, body: data.body, baseSha: data.baseSha ?? null, headSha: data.headSha ?? null, diff: data.diff }));
}

export function canReuseCache(cached, data, fingerprint) {
  return Boolean(cached?.meta?.generationId && cached.meta.configFingerprint === fingerprint && cached.meta.inputHash === inputHash(data));
}

export function canPatchCache(cached, data, fingerprint) {
  return Boolean(cached?.meta?.generationId && cached.meta.configFingerprint === fingerprint && cached.meta.source === data.source && cached.meta.repositoryPath === (data.repositoryPath || null) && cached.meta.headBranch === data.headBranch && cached.meta.baseSha === data.baseSha && cached.meta.headSha && data.headSha);
}
