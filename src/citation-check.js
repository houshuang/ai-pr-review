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

export function walkthroughTexts(walkthrough) {
  const texts = [{ where: "overview", text: walkthrough.overview }];
  for (const section of walkthrough.sections || []) {
    texts.push({ where: `section ${section.id} narrative`, text: section.narrative });
    for (const hunk of section.hunks || []) texts.push({ where: `section ${section.id} annotation for ${hunk.file}`, text: hunk.annotation });
    for (const callout of section.callouts || []) texts.push({ where: `section ${section.id} callout "${callout.label}"`, text: callout.text });
  }
  (walkthrough.review_tips || []).forEach((tip, index) => texts.push({ where: `review tip ${index + 1}`, text: typeof tip === "string" ? tip : tip.tip }));
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

// After repair rounds run out, a citation that still points nowhere loses its line so the viewer does not link it.
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
