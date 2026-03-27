import { h } from "preact";
import { useRef, useEffect } from "preact/hooks";
import { diff2htmlHtml } from "../diff";
import { getBlockEndLines } from "../diff";
import { expandContext } from "../api";
import { isGitHubPR, findFile, showFullFile, toggleSet, parsedFiles } from "../state";
import { esc, md, linkFileRefs } from "../utils";
import { closeTags, nodeStream, mergeStreams, getLanguage } from "diff2html/lib-esm/ui/js/highlight.js-helpers";

function highlightDiffCode(container, filePath) {
  const hljs = window.hljs;
  if (!hljs) return;

  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return;
  const lang = getLanguage(ext);
  if (!lang || lang === "plaintext") return;
  if (!hljs.getLanguage(lang)) return;

  container.querySelectorAll(".d2h-code-line-ctn").forEach((el) => {
    const text = el.textContent;
    if (text === null) return;

    try {
      const result = closeTags(hljs.highlight(text, { language: lang, ignoreIllegals: true }));
      const originalStream = nodeStream(el);
      if (originalStream.length) {
        const resultNode = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
        resultNode.innerHTML = result.value;
        result.value = mergeStreams(originalStream, nodeStream(resultNode), text);
      }
      el.classList.add("hljs");
      el.innerHTML = result.value;
    } catch (e) {
      // Ignore per-line highlighting errors
    }
  });
}

function injectInlineAnnotations(container, fileHunks) {
  if (!fileHunks) return;

  // Build map of new-file line numbers to their <tr> elements.
  // Unified (line-by-line) mode uses .line-num2 divs; side-by-side uses the
  // right table's .d2h-code-side-linenumber td text directly.
  const lineToRow = new Map();
  container.querySelectorAll(".line-num2").forEach((el) => {
    const num = parseInt(el.textContent);
    if (!isNaN(num)) {
      const row = el.closest("tr");
      if (row) lineToRow.set(num, row);
    }
  });

  // Side-by-side fallback: query the new-file (right) table
  const isSideBySide = lineToRow.size === 0;
  if (isSideBySide) {
    const sideDiffs = container.querySelectorAll(".d2h-file-side-diff");
    const rightSide = sideDiffs[sideDiffs.length - 1]; // last = new-file table
    if (rightSide) {
      rightSide.querySelectorAll(".d2h-code-side-linenumber").forEach((el) => {
        const num = parseInt(el.textContent.trim());
        if (!isNaN(num) && num > 0) {
          const row = el.closest("tr");
          if (row) lineToRow.set(num, row);
        }
      });
    }
  }

  if (lineToRow.size === 0) return;
  const lineNums = [...lineToRow.keys()].sort((a, b) => a - b);

  // Detect column count from existing rows
  const sampleRow = lineToRow.values().next().value;
  const colCount = sampleRow ? sampleRow.querySelectorAll("td").length : 2;

  for (const hunk of fileHunks) {
    if (!hunk.annotation) continue;
    const endLine = hunk.endLine || hunk.startLine;
    if (!endLine) continue;

    // Find the closest line at or before endLine
    let targetLineNum = null;
    for (const num of lineNums) {
      if (num <= endLine) targetLineNum = num;
      else break;
    }
    if (targetLineNum === null && lineNums.length > 0) {
      targetLineNum = lineNums[0];
    }
    if (targetLineNum === null) continue;

    const row = lineToRow.get(targetLineNum);
    if (!row) continue;

    const imp = hunk.importance || "important";
    const lineLabel = hunk.startLine
      ? (hunk.startLine === hunk.endLine ? `L${hunk.startLine}` : `L${hunk.startLine}\u2013${hunk.endLine}`)
      : "";

    // Wrap content in a div so that display:block doesn't break colspan on the td
    const annotationRow = document.createElement("tr");
    annotationRow.className = "annotation-row";
    const td = document.createElement("td");
    td.colSpan = colCount;
    const div = document.createElement("div");
    div.className = `hunk-annotation-inline annotation-${imp}`;
    div.innerHTML = `<span class="annotation-lines">${lineLabel}</span>${linkFileRefs(md(hunk.annotation))}`;
    td.appendChild(div);
    annotationRow.appendChild(td);
    row.after(annotationRow);

    // In side-by-side mode, mirror a styled spacer into the left (old-file) table
    // so the two tables stay vertically aligned and the annotation looks full-width
    if (isSideBySide) {
      const filesDiff = row.closest(".d2h-files-diff");
      const leftSide = filesDiff?.querySelector(".d2h-file-side-diff");
      const leftTbody = leftSide?.querySelector("tbody");
      const rightTbody = row.closest("tbody");
      if (leftTbody && rightTbody) {
        const rowIndex = Array.from(rightTbody.rows).indexOf(row);
        const leftRow = leftTbody.rows[rowIndex];
        if (leftRow) {
          const spacerRow = document.createElement("tr");
          spacerRow.className = "annotation-row";
          const spacerTd = document.createElement("td");
          spacerTd.colSpan = colCount;
          const spacerDiv = document.createElement("div");
          spacerDiv.className = `hunk-annotation-inline annotation-${imp} annotation-sbs-spacer`;
          spacerRow.appendChild(spacerTd);
          spacerTd.appendChild(spacerDiv);
          leftRow.after(spacerRow);
        }
      }
    }
  }

  // Apply highlight.js to code blocks within annotations
  if (window.hljs) {
    container.querySelectorAll(".hunk-annotation-inline pre code").forEach((el) => {
      window.hljs.highlightElement(el);
    });
  }
}

export function DiffView({ file, mode, filePath, hunkKey, fileHunks, showExpandBars }) {
  const containerRef = useRef();

  const diffHtml = buildDiffHtml(file, mode, filePath, hunkKey, showExpandBars);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = diffHtml;

    // Apply syntax highlighting to diff code lines
    highlightDiffCode(containerRef.current, filePath);

    // Inject annotations inline at the right line positions
    injectInlineAnnotations(containerRef.current, fileHunks);

    // Attach expand context click handlers via event delegation
    const handler = async (e) => {
      const bar = e.target.closest("[data-expand-file]");
      if (!bar) return;
      const expandFilePath = bar.dataset.expandFile;
      const dir = bar.dataset.expandDir;
      const blockStart = parseInt(bar.dataset.expandBlock);
      const expandHunkKey = bar.dataset.expandHunkKey;

      bar.textContent = "Loading...";
      bar.classList.add("loading");
      if (expandHunkKey) {
        const next = new Set(showFullFile.value);
        next.add(expandHunkKey);
        showFullFile.value = next;
      }
      const changed = await expandContext(expandFilePath, dir, blockStart, findFile);
      if (changed) {
        parsedFiles.value = { ...parsedFiles.value };
      }
    };

    containerRef.current.addEventListener("click", handler);
    return () => {
      if (containerRef.current) {
        containerRef.current.removeEventListener("click", handler);
      }
    };
  }, [diffHtml, fileHunks, filePath]);

  return <div ref={containerRef} className="diff-view-container" />;
}

function hasNoDeletions(file) {
  if (!file.blocks || !file.blocks.length) return false;
  return file.blocks.every(block =>
    block.lines.every(line => line.type !== "delete")
  );
}

function buildDiffHtml(file, mode, filePath, hunkKey, showExpandBars) {
  // Add-only chunks (no deletions) → force unified to avoid empty left pane
  if (mode !== "unified" && hasNoDeletions(file)) mode = "unified";

  const blocks = file.blocks;
  if (!blocks || !blocks.length) {
    return diff2htmlHtml([file], {
      drawFileList: false,
      matching: "lines",
      outputFormat: mode === "unified" ? "line-by-line" : "side-by-side",
      rawTemplates: {},
    });
  }

  const canExpand = showExpandBars && isGitHubPR();
  let html = "";

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    if (canExpand) {
      if (i === 0 && block.newStartLine > 1) {
        const count = Math.min(20, block.newStartLine - 1);
        html += `<div class="expand-context-bar" data-expand-file="${esc(filePath)}" data-expand-dir="up" data-expand-block="${block.newStartLine}" data-expand-hunk-key="${esc(hunkKey)}"><span class="expand-icon">\u22ee</span> Show ${count} line${count > 1 ? "s" : ""} above</div>`;
      } else if (i > 0) {
        const { lastNew: prevEnd } = getBlockEndLines(blocks[i - 1]);
        const gap = block.newStartLine - prevEnd - 1;
        if (gap > 0) {
          html += `<div class="expand-context-bar" data-expand-file="${esc(filePath)}" data-expand-dir="between" data-expand-block="${block.newStartLine}" data-expand-hunk-key="${esc(hunkKey)}"><span class="expand-icon">\u22ee</span> Show ${gap} hidden line${gap > 1 ? "s" : ""}</div>`;
        }
      }
    }

    const singleBlockFile = { ...file, blocks: [block] };
    html += diff2htmlHtml([singleBlockFile], {
      drawFileList: false,
      matching: "lines",
      outputFormat: mode === "unified" ? "line-by-line" : "side-by-side",
    });
  }

  if (canExpand && blocks.length > 0) {
    html += `<div class="expand-context-bar" data-expand-file="${esc(filePath)}" data-expand-dir="down" data-expand-block="${blocks[blocks.length - 1].newStartLine}" data-expand-hunk-key="${esc(hunkKey)}"><span class="expand-icon">\u22ee</span> Show 20 lines below</div>`;
  }

  return html;
}
