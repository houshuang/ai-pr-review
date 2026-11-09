import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sourceCitation } from "./source-links.js";

const run = promisify(execFile);
const gitOptions = { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 };

// Reads one revision's tree through git, without a checkout of it.
export function gitRevisionReader(cwd, revision) {
  let files = null;
  const lineCounts = new Map();
  return {
    async listFiles() {
      if (!files) {
        const { stdout } = await run("git", ["ls-tree", "-r", "--name-only", revision], { ...gitOptions, cwd });
        files = new Set(stdout.split("\n").filter(Boolean));
      }
      return files;
    },
    async lineCount(path) {
      if (!lineCounts.has(path)) {
        const { stdout } = await run("git", ["cat-file", "blob", `${revision}:${path}`], { ...gitOptions, cwd });
        lineCounts.set(path, stdout.endsWith("\n") ? stdout.split("\n").length - 1 : stdout.split("\n").length);
      }
      return lineCounts.get(path);
    },
  };
}

// Every prose text that can carry a citation, with the files its section shows and a way to rewrite it.
export function walkthroughTexts(walkthrough) {
  const texts = [];
  const add = (where, owner, field, files = []) => texts.push({ where, text: owner[field], files, set: (value) => { owner[field] = value; } });
  add("overview", walkthrough, "overview");
  for (const section of walkthrough.sections || []) {
    const files = (section.hunks || []).map((hunk) => hunk.file);
    add(`section ${section.id} narrative`, section, "narrative", files);
    for (const hunk of section.hunks || []) add(`section ${section.id} annotation for ${hunk.file}`, hunk, "annotation", [hunk.file]);
    for (const callout of section.callouts || []) add(`section ${section.id} callout "${callout.label}"`, callout, "text", files);
  }
  (walkthrough.review_tips || []).forEach((tip, index) => typeof tip === "string"
    ? add(`review tip ${index + 1}`, walkthrough.review_tips, index)
    : add(`review tip ${index + 1}`, tip, "tip"));
  return texts.filter((entry) => typeof entry.text === "string" && entry.text);
}

// Resolves a path the way the source preview does: a bare filename by its unique match, anything else exactly.
function resolvePath(path, files) {
  if (files.has(path)) return { path };
  if (path.includes("/")) return { problem: "is not a file at that revision" };
  const matches = [...files].filter((file) => file.endsWith(`/${path}`));
  if (matches.length === 1) return { path: matches[0] };
  return { problem: matches.length ? `matches ${matches.length} files; cite the full path` : "is not a file at that revision" };
}

/**
 * Citations (`path:line` or `base path:line`) whose file or lines do not exist
 * at the revision they name. A revision without a reader is not checked.
 */
export async function citationProblems(walkthrough, { head, base = null }) {
  const problems = [];
  for (const { where, text } of walkthroughTexts(walkthrough)) {
    for (const match of text.matchAll(sourceCitation())) {
      const [cited, baseLabel, path, line, end] = match;
      if (path.startsWith("/") || path.split("/").includes("..")) continue;
      if (/[:/]/.test(text[match.index - 1] || "")) continue;
      const reader = baseLabel ? base : head;
      if (!reader) continue;
      const revision = baseLabel ? "base" : "head";
      const resolved = resolvePath(path, await reader.listFiles());
      if (resolved.problem) {
        problems.push({ check: "citation", where, cited: cited.trim(), message: `${where}: citation \`${cited.trim()}\` ${resolved.problem} (${revision})` });
        continue;
      }
      const last = Number(end || line);
      const count = await reader.lineCount(resolved.path);
      if (last > count) {
        problems.push({ check: "citation", where, cited: cited.trim(), message: `${where}: citation \`${cited.trim()}\` is past the end of ${resolved.path}, which has ${count} lines at the ${revision}` });
      }
    }
  }
  return problems;
}

// The files a short or partial path can mean. Among several, one too short to hold the cited line is ruled out, then the files the surrounding text shows are preferred.
async function candidateFiles(path, line, reader, preferred) {
  const files = await reader.listFiles();
  if (files.has(path)) return [path];
  let candidates = [...files].filter((file) => file.endsWith(`/${path}`));
  if (candidates.length > 1) {
    const counts = await Promise.all(candidates.map((file) => reader.lineCount(file)));
    candidates = candidates.filter((file, index) => counts[index] >= line);
  }
  for (const group of preferred) {
    if (candidates.length < 2) break;
    const kept = candidates.filter((file) => group.has(file));
    if (kept.length) candidates = kept;
  }
  return candidates;
}

/**
 * Rewrites citations the check would reject wherever the tree settles what
 * they mean: a short or partial path becomes the one file it can name, and a
 * range that runs past the end of its file stops at the last line. Returns how
 * many citations changed; anything still wrong is left for the check to report.
 */
export async function repairCitations(walkthrough, { head, base = null }, changedPaths = []) {
  const changed = new Set(changedPaths);
  let repaired = 0;
  for (const entry of walkthroughTexts(walkthrough)) {
    const edits = [];
    for (const match of entry.text.matchAll(sourceCitation())) {
      const [cited, baseLabel = "", path, line, end] = match;
      if (path.startsWith("/") || path.split("/").includes("..")) continue;
      if (/[:/]/.test(entry.text[match.index - 1] || "")) continue;
      const reader = baseLabel ? base : head;
      if (!reader) continue;
      const first = Number(line), last = Number(end || line);
      const accepted = resolvePath(path, await reader.listFiles()).path;
      if (accepted && last <= await reader.lineCount(accepted)) continue;
      const candidates = await candidateFiles(path, first, reader, [new Set(entry.files), changed]);
      if (candidates.length !== 1) continue;
      const count = await reader.lineCount(candidates[0]);
      if (first > count) continue;
      const range = cited.slice(baseLabel.length + path.length);
      const fitted = last <= count ? range : first === count ? `:${line}` : range.replace(/\d+$/, count);
      const fixed = `${baseLabel}${candidates[0]}${fitted}`;
      if (fixed !== cited) edits.push({ index: match.index, length: cited.length, fixed });
    }
    if (!edits.length) continue;
    let text = entry.text;
    for (const edit of edits.reverse()) text = text.slice(0, edit.index) + edit.fixed + text.slice(edit.index + edit.length);
    entry.set(text);
    repaired += edits.length;
  }
  return repaired;
}

// A citation that still points nowhere after repair loses its line so the viewer does not link it.
export function unlinkCitations(walkthrough, problems) {
  const bad = new Set(problems.filter((problem) => problem.check === "citation").map((problem) => problem.cited));
  if (!bad.size) return walkthrough;
  const strip = (text) => typeof text === "string"
    ? text.replace(sourceCitation(), (match, baseLabel, path) => bad.has(match.trim()) ? `${baseLabel || ""}${path}` : match)
    : text;
  walkthrough.overview = strip(walkthrough.overview);
  for (const section of walkthrough.sections) {
    section.narrative = strip(section.narrative);
    for (const hunk of section.hunks) hunk.annotation = strip(hunk.annotation);
    for (const callout of section.callouts) callout.text = strip(callout.text);
  }
  walkthrough.review_tips = (walkthrough.review_tips || []).map((tip) => typeof tip === "string" ? strip(tip) : { ...tip, tip: strip(tip.tip) });
  return walkthrough;
}
