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

export function filterFileToRanges(file, ranges) {
  if (!file || !ranges || ranges.length === 0) return file;

  const CONTEXT = 5;
  const expanded = ranges
    .filter((r) => r.startLine && r.endLine)
    .map((r) => ({ start: r.startLine - CONTEXT, end: r.endLine + CONTEXT }));

  if (expanded.length === 0) return file;

  const filtered = file.blocks.filter((block) => {
    const blockStart = block.newStartLine;
    let blockEnd = blockStart;
    for (const line of block.lines) {
      if (line.newNumber) blockEnd = Math.max(blockEnd, line.newNumber);
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
