import { html as diff2htmlHtml, parse as diff2htmlParse } from "diff2html";

export function parseDiff(rawDiff) {
  const files = diff2htmlParse(rawDiff);
  const byFile = {};
  for (const file of files) {
    const name = file.isDeleted ? file.oldName : file.newName || file.oldName;
    byFile[name] = file;
  }
  return byFile;
}

export function renderFileDiff(file, mode) {
  if (!file) return '<div class="no-diff">File not found in diff</div>';
  return diff2htmlHtml([file], {
    drawFileList: false,
    matching: "lines",
    outputFormat: mode === "unified" ? "line-by-line" : "side-by-side",
    rawTemplates: {},
  });
}

// Side-by-side only pays off when deletions and additions pair up. A block that
// is mostly one-sided leaves a near-empty pane and halves the width available to
// long lines, so it renders unified even when side-by-side is selected.
const MIN_SIDE_BY_SIDE_BALANCE = 0.4;

export function blockLayout(block, mode) {
  if (mode === "unified") return "unified";
  let adds = 0;
  let dels = 0;
  for (const line of block.lines || []) {
    if (line.type === "insert") adds++;
    else if (line.type === "delete") dels++;
  }
  if (adds === 0 || dels === 0) return "unified";
  return Math.min(adds, dels) / Math.max(adds, dels) >= MIN_SIDE_BY_SIDE_BALANCE
    ? "side-by-side"
    : "unified";
}

export function filterFileToRanges(file, ranges) {
  if (!file || !ranges || ranges.length === 0) return file;

  const CONTEXT = 5;
  const expanded = ranges
    .filter((r) => r.startLine && r.endLine)
    .map((r) => ({ start: r.startLine - CONTEXT, end: r.endLine + CONTEXT }));

  if (expanded.length === 0) return file;

  const filtered = file.blocks.filter((block) => {
    const blockStart = file.isDeleted ? block.oldStartLine : block.newStartLine;
    let blockEnd = blockStart;
    for (const line of block.lines) {
      const number = file.isDeleted ? line.oldNumber : line.newNumber;
      if (number) blockEnd = Math.max(blockEnd, number);
    }
    return expanded.some((r) => blockStart <= r.end && blockEnd >= r.start);
  });

  if (filtered.length === file.blocks.length) return file;

  return {
    ...file,
    blocks: filtered,
    addedLines: filtered.reduce((n, b) => n + b.lines.filter((l) => l.type === "insert").length, 0),
    deletedLines: filtered.reduce((n, b) => n + b.lines.filter((l) => l.type === "delete").length, 0),
  };
}

export function getBlockEndLines(block) {
  let lastNew = block.newStartLine;
  let lastOld = block.oldStartLine;
  for (const line of block.lines) {
    if (line.newNumber) lastNew = Math.max(lastNew, line.newNumber);
    if (line.oldNumber) lastOld = Math.max(lastOld, line.oldNumber);
  }
  return { lastNew, lastOld };
}

export function findDefinitionsInDiff(identifier, parsedFiles) {
  if (!identifier || identifier.length < 2) return [];
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const defPattern = new RegExp(
    `(?:function\\*?|class|const|let|var|type|interface|enum|export\\s+(?:default\\s+)?(?:function\\*?|class|const|let|var|type|interface|enum)|def|fn|func)\\s+${escaped}\\b`
  );

  const results = [];
  for (const [filePath, file] of Object.entries(parsedFiles)) {
    for (const block of file.blocks) {
      for (const line of block.lines) {
        if (line.type === "delete") continue;
        if (defPattern.test(line.content)) {
          results.push({ filePath, line: line.newNumber || line.oldNumber, content: line.content });
        }
      }
    }
  }
  return results;
}

export { diff2htmlHtml };
