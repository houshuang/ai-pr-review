import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deadOwner(owner) {
  const pid = Number(owner.split(":")[0]);
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); } catch (error) { return error.code === "ESRCH"; }
  return false;
}

function recoverAbandoned(path, owner, token, depth = 0) {
  if (!deadOwner(owner) || depth > 8) return false;
  const election = `${path}.reap-${createHash("sha256").update(owner).digest("hex").slice(0, 16)}`;
  try { writeFileSync(election, token, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    try { recoverAbandoned(election, readFileSync(election, "utf8"), token, depth + 1); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return false;
  }
  try {
    if (readFileSync(path, "utf8") === owner) unlinkSync(path);
    return true;
  } catch (error) { if (error.code === "ENOENT") return true; throw error; }
  finally { unlinkSync(election); }
}

// The PID lets a later run recover a lock abandoned by a killed resolver.
export async function acquireFileLock(path, { timeoutMs = 30000 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  const token = `${process.pid}:${randomUUID()}`;
  while (true) {
    try {
      // Acquisition and stale recovery share one gate, so a second reaper cannot
      // remove the replacement lock after the first reaper has recovered it.
      const gate = `${path}.gate`;
      try {
        writeFileSync(gate, token, { flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          if (recoverAbandoned(gate, readFileSync(gate, "utf8"), token)) continue;
        } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (Date.now() - started >= timeoutMs) return null;
        await pause(20);
        continue;
      }
      try {
        if (existsSync(path)) {
          const owner = readFileSync(path, "utf8");
          const pid = Number(owner.split(":")[0]);
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (error) {
              if (error.code === "ESRCH") unlinkSync(path);
            }
          }
        }
        writeFileSync(path, token, { flag: "wx" });
      } finally { unlinkSync(gate); }
      return async () => {
        try {
          if (await readFile(path, "utf8") === token) await unlink(path);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) return null;
      await pause(20);
    }
  }
}

async function publish(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(content, null, 2));
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function withWriter(path, action) {
  const release = await acquireFileLock(`${path}.write.lock`);
  if (!release) throw new Error(`Timed out waiting to write ${path}`);
  try { return await action(); } finally { await release(); }
}

export async function writeReviewFile(path, content) {
  return withWriter(path, async () => {
    let latest;
    try { latest = JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    const next = structuredClone(content);
    if (sameReview(latest?.meta, next.meta)) {
      const terminal = new Map((latest.walkthrough?.review_tips || []).filter((tip) => tip.resolved && !tip.pending).map((tip) => [tip.tip, tip]));
      if (Array.isArray(next.walkthrough?.review_tips)) next.walkthrough.review_tips = next.walkthrough.review_tips.map((tip) => tip.pending && terminal.has(tip.tip) ? terminal.get(tip.tip) : tip);
    }
    return publish(path, next);
  });
}

export function sameReview(meta, expected) {
  if (!meta?.generationId || !expected?.generationId) return false;
  return ["generationId", "owner", "repo", "number", "headSha", "source", "provenance"].every(
    (key) => (meta[key] ?? null) === (expected[key] ?? null),
  );
}

export async function updateReviewTip(path, expectedMeta, original, resolved) {
  return withWriter(path, async () => {
    let content;
    try { content = JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (!sameReview(content.meta, expectedMeta)) return false;
    const tips = content?.walkthrough?.review_tips;
    if (!Array.isArray(tips)) return false;
    const text = typeof original === "string" ? original : original.tip;
    const index = tips.findIndex((tip) => tip?.tip === text && tip.pending);
    if (index < 0) return false;
    if (!["verified", "concern", "info"].includes(resolved.status)) throw new Error("Invalid tip status");
    tips[index] = { ...tips[index], ...resolved };
    if (!resolved.pending) delete tips[index].pending;
    await publish(path, content);
    return true;
  });
}
