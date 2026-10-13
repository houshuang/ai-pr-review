import { sourceCitation } from "./source-links.js";

// What a file's patch changes, without hunk positions or context, so a rebase that only moves lines keeps it.
const changeSignature = (patch) => (patch || "").replace(/\n+$/, "").split("\n").filter((line) => /^[+-]/.test(line)).join("\n");

function storedPatches(diff) {
  const patches = new Map();
  for (const part of (diff || "").split(/^diff --git /m).slice(1)) {
    const path = (part.match(/^\+\+\+ b\/(.+)$/m) || part.match(/^--- a\/(.+)$/m) || [])[1];
    if (!path) continue;
    const start = part.indexOf("\n@@");
    patches.set(path, start < 0 ? "" : part.slice(start + 1));
  }
  return patches;
}

/**
 * The PR's files whose own change differs from the one the walkthrough
 * explained. `currentFiles` is GitHub's pull-request file list; a file GitHub
 * sends without a patch (too large) counts as unchanged, since it cannot be compared.
 */
export function changedPatchFiles(walkthroughDiff, currentFiles) {
  const then = storedPatches(walkthroughDiff);
  const now = new Map(currentFiles.map((file) => [file.filename, file.patch ?? null]));
  const changed = [];
  for (const path of new Set([...then.keys(), ...now.keys()])) {
    if (!then.has(path) || !now.has(path)) changed.push(path);
    else if (now.get(path) !== null && changeSignature(now.get(path)) !== changeSignature(then.get(path))) changed.push(path);
  }
  return changed;
}

/** Per section id, the changed files it shows or cites at the head, each once. */
export function staleSectionFiles(walkthrough, changedPaths) {
  const changed = new Set(changedPaths);
  const resolve = (path) => changed.has(path) ? path : path.includes("/") ? null : changedPaths.find((file) => file.endsWith(`/${path}`)) || null;
  const result = {};
  for (const section of walkthrough.sections || []) {
    const files = new Set();
    for (const hunk of section.hunks || []) if (changed.has(hunk.file)) files.add(hunk.file);
    for (const text of [section.narrative, ...(section.hunks || []).map((hunk) => hunk.annotation), ...(section.callouts || []).map((callout) => callout.text)]) {
      for (const [, base, path] of String(text || "").matchAll(sourceCitation())) {
        const file = !base && resolve(path);
        if (file) files.add(file);
      }
    }
    if (files.size) result[section.id] = [...files];
  }
  return result;
}
