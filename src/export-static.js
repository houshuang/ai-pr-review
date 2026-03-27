/**
 * Export a walkthrough JSON as a self-contained static HTML file.
 *
 * Usage:
 *   node src/export-static.js <slug-or-path> [--output path.html] [--mode side-by-side|unified]
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { html as diff2htmlHtml, parse as diff2htmlParse } from "diff2html";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Utility functions (same as utils.js) ──

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function md(text) {
  if (!text) return "";
  const codeBlocks = [];
  let result = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const i = codeBlocks.length;
      codeBlocks.push(`<pre><code${lang ? ` class="language-${lang}"` : ""}>${code.trim()}</code></pre>`);
      return `\x00CB${i}\x00`;
    })
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^## (.+)$/gm, "<h3>$1</h3>")
    .replace(/^# (.+)$/gm, "<h2>$1</h2>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
    .replace(/\n\n/g, "</p><p>")
    .replace(/^(?!<[huplo])(.+)$/gm, (_, line) =>
      line.trim() ? `<p>${line}</p>` : ""
    )
    .replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[i]);
  return result;
}

function groupFilesByDirectory(filePaths) {
  const groups = new Map();
  for (const path of filePaths) {
    const parts = path.split("/");
    const dir = parts.length > 1 ? parts.slice(0, Math.min(parts.length - 1, 3)).join("/") : "";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(path);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function getFileStats(file) {
  let additions = 0, deletions = 0;
  for (const block of file.blocks || []) {
    for (const line of block.lines || []) {
      if (line.type === "insert") additions++;
      if (line.type === "delete") deletions++;
    }
  }
  return { additions, deletions };
}

// ── Diff rendering ──

function parseDiff(rawDiff) {
  const files = diff2htmlParse(rawDiff);
  const byFile = {};
  for (const file of files) {
    const name = file.isDeleted ? file.oldName : file.newName || file.oldName;
    byFile[name] = file;
  }
  return byFile;
}

function filterFileToRanges(file, ranges) {
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
  return { ...file, blocks: filtered };
}

function hasNoDeletions(file) {
  if (!file.blocks || !file.blocks.length) return false;
  return file.blocks.every(block =>
    block.lines.every(line => line.type !== "delete")
  );
}

function renderDiffHtml(file, mode) {
  if (!file || !file.blocks?.length) return "";
  // Add-only chunks (no deletions) → force unified to avoid empty left pane
  if (mode !== "unified" && hasNoDeletions(file)) mode = "unified";
  return diff2htmlHtml([file], {
    drawFileList: false,
    matching: "lines",
    outputFormat: mode === "unified" ? "line-by-line" : "side-by-side",
  });
}

// ── Component renderers ──

function renderHeader(meta, wt, reviews) {
  const reviewerNames = (reviews || [])
    .filter((r) => r.state !== "PENDING" && r.state !== "DISMISSED" && r.user)
    .map((r) => r.user)
    .filter((v, i, a) => a.indexOf(v) === i);

  return `
    <header class="page-header">
      <div class="kicker">Code Review Walkthrough</div>
      <h1>${esc(wt.title)}</h1>
      <p class="subtitle">${esc(wt.subtitle)}</p>
      <div class="meta">
        ${meta.author ? `<span class="meta-item meta-author">by ${esc(meta.author)}</span>` : ""}
        ${meta.url ? `<span class="meta-item"><a href="${esc(meta.url)}" target="_blank">PR Link &#x2197;</a></span>` : ""}
        <span class="meta-item">${esc(meta.headBranch)} &rarr; ${esc(meta.baseBranch)}</span>
        <span class="meta-item">+${meta.additions} &minus;${meta.deletions}</span>
        <span class="meta-item">${meta.changedFiles} files</span>
        ${reviewerNames.length > 0 ? `<span class="meta-item meta-reviewers">Reviewers: ${esc(reviewerNames.join(", "))}</span>` : ""}
      </div>
    </header>`;
}

// Same logic as state.js getEstimatedReadTime
function getEstimatedReadTime(section, parsedFiles) {
  let wordCount = 0;
  let codeLines = 0;
  if (section.narrative) wordCount += section.narrative.split(/\s+/).length;
  for (const c of section.callouts || []) {
    if (c.text) wordCount += c.text.split(/\s+/).length;
  }
  for (const hunk of section.hunks || []) {
    const file = parsedFiles[hunk.file];
    if (file) {
      for (const block of file.blocks || []) {
        codeLines += block.lines?.length || 0;
      }
    }
    if (hunk.annotation) wordCount += hunk.annotation.split(/\s+/).length;
  }
  const minutes = wordCount / 200 + codeLines / 30;
  return Math.max(1, Math.round(minutes));
}

// Same structure as SidebarLayout.jsx sidebar
function renderSidebar(meta, wt, parsedFiles) {
  // Coverage: which files are in walkthrough vs not
  const coveredFiles = new Set();
  for (const s of wt.sections || []) {
    for (const h of s.hunks || []) coveredFiles.add(h.file);
  }
  const allFiles = Object.keys(parsedFiles).sort();

  // TOC items with read times (same as TOC.jsx)
  const tocItems = (wt.sections || []).map((s, i) => {
    const readTime = getEstimatedReadTime(s, parsedFiles);
    return `<li><a href="#section-${esc(s.id)}"><span class="toc-title">${esc(s.title)}</span><span class="toc-meta">${readTime} min</span></a></li>`;
  }).join("");

  const uncoveredCount = allFiles.filter((f) => !coveredFiles.has(f)).length;

  // File tree grouped by directory (same as SidebarFileTree in SidebarLayout.jsx)
  const groups = groupFilesByDirectory(allFiles);
  const fileTreeHtml = groups.map(([dir, files]) => {
    const dirFiles = files.map((f) => {
      const isCovered = coveredFiles.has(f);
      const dotClass = isCovered ? "covered" : "uncovered";
      const name = f.split("/").pop();
      const file = parsedFiles[f];
      const stats = file ? getFileStats(file) : null;
      return `<div class="sidebar-file"><span class="sidebar-dot ${dotClass}"></span><span class="sidebar-fname">${esc(name)}</span>${stats ? `<span class="sidebar-fstats">+${stats.additions} -${stats.deletions}</span>` : ""}</div>`;
    }).join("");
    return `<div class="sidebar-dir">${esc(dir || "(root)")}/</div>${dirFiles}`;
  }).join("");

  return `
    <aside class="static-sidebar">
      <div class="sidebar-header-block">
        <div class="kicker">Review</div>
        <h3 style="font-family:var(--display);font-weight:400;font-size:1rem;margin:0.25rem 0">${esc(wt.title)}</h3>
        <div class="meta" style="margin-top:0.5rem">${esc(meta.headBranch)} &rarr; ${esc(meta.baseBranch)}</div>
      </div>
      <nav class="toc">
        <ol>
          ${tocItems}
          ${uncoveredCount > 0 ? `<li><a href="#section-remaining"><span class="toc-title">Remaining Changes</span><span class="toc-meta">${uncoveredCount} files</span></a></li>` : ""}
          ${wt.file_map?.length ? `<li><a href="#section-file-map"><span class="toc-title">File Map</span></a></li>` : ""}
        </ol>
      </nav>
      <div class="sidebar-files">
        <div class="sidebar-section-title">Files</div>
        ${fileTreeHtml}
      </div>
    </aside>`;
}

function renderOverview(wt) {
  let html = `
    <section id="section-overview">
      <span class="section-number">Overview</span>
      <h2>The Big Picture</h2>
      <div class="narrative">${md(wt.overview)}</div>`;

  if (wt.architecture_diagram) {
    html += `
      <div class="diagram-container">
        <div class="diagram-label">Architecture</div>
        <div class="mermaid-source">${esc(wt.architecture_diagram)}</div>
      </div>`;
  }

  if (wt.review_tips?.length) {
    html += `
      <div class="callout insight">
        <span class="callout-label">Review Tips</span>
        <ul>${wt.review_tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      </div>`;
  }

  html += `</section>`;
  return html;
}

function renderCallout(type, label, text) {
  return `
    <div class="callout ${esc(type)}">
      <span class="callout-label">${esc(label)}</span>
      <span>${md(text)}</span>
    </div>`;
}

function renderAnnotationBlock(hunk) {
  const imp = hunk.importance || "important";
  const lineLabel = hunk.startLine
    ? (hunk.startLine === hunk.endLine ? `L${hunk.startLine}` : `L${hunk.startLine}\u2013${hunk.endLine}`)
    : "";
  const endLine = hunk.endLine || hunk.startLine || 0;
  return `<div class="hunk-annotation annotation-${esc(imp)}" data-target-line="${endLine}" data-start-line="${hunk.startLine || 0}"><span class="annotation-lines">${lineLabel}</span>${md(hunk.annotation)}</div>`;
}

function renderHunkGroup(filePath, fileHunks, sectionId, parsedFiles, mode, gitHistory) {
  const file = parsedFiles[filePath];
  const importanceOrder = { critical: 0, important: 1, supporting: 2, context: 3 };
  const topImportance = fileHunks.reduce((best, h) => {
    const hImp = h.importance || "important";
    return (importanceOrder[hImp] || 2) < (importanceOrder[best] || 2) ? hImp : best;
  }, fileHunks[0].importance || "important");

  const lineRanges = fileHunks
    .filter((h) => h.startLine)
    .map((h) => h.startLine === h.endLine ? `L${h.startLine}` : `L${h.startLine}\u2013${h.endLine}`)
    .join(", ");

  // Age / churn badges
  const age = gitHistory?.fileAges?.[filePath];
  const churn = gitHistory?.churn?.[filePath];
  let ageBadgeHtml = "";
  if (age) {
    const days = age.daysSince;
    let label, cls;
    if (days > 365) { label = `${Math.floor(days / 365)}y old`; cls = "age-old"; }
    else if (days > 90) { label = `${Math.floor(days / 30)}mo old`; cls = "age-moderate"; }
    else if (days > 7) { label = `${days}d old`; cls = "age-recent"; }
    if (label) ageBadgeHtml = `<span class="file-age-badge ${cls}">${esc(label)}</span>`;
  }
  let churnBadgeHtml = "";
  if (churn && churn.touchCount >= 2) {
    churnBadgeHtml = `<span class="file-churn-badge">${churn.touchCount}&times; revised</span>`;
  }

  // Render diff (without annotations — those are injected client-side)
  let diffHtml = "";
  if (file) {
    const filteredFile = filterFileToRanges(file, fileHunks);
    diffHtml = renderDiffHtml(filteredFile, mode);
  } else {
    diffHtml = `<div class="no-diff">File &quot;${esc(filePath)}&quot; not found in diff</div>`;
  }

  // Render annotations as fallback blocks (client JS will move them inline)
  const annotationHunks = fileHunks.filter((h) => h.annotation);
  const annotationsHtml = annotationHunks.length > 0
    ? `<div class="hunk-annotations">${annotationHunks.map((h) => renderAnnotationBlock(h)).join("")}</div>`
    : "";

  return `
    <div class="hunk-group importance-${esc(topImportance)}">
      <div class="hunk-header">
        <span class="hunk-file">${esc(filePath)}</span>
        <span class="hunk-lines">${lineRanges}</span>
        <span class="hunk-count">${fileHunks.length} annotation${fileHunks.length > 1 ? "s" : ""}</span>
        ${ageBadgeHtml}
        ${churnBadgeHtml}
        <span class="hunk-importance importance-badge-${esc(topImportance)}">${esc(topImportance)}</span>
      </div>
      <div class="hunk-diff">${diffHtml}</div>
      ${annotationsHtml}
    </div>`;
}

function renderSection(section, index, parsedFiles, mode, gitHistory) {
  const fileCount = new Set(section.hunks?.map((h) => h.file) || []).size;

  const fileGroups = new Map();
  if (section.hunks) {
    for (const hunk of section.hunks) {
      if (!fileGroups.has(hunk.file)) fileGroups.set(hunk.file, []);
      fileGroups.get(hunk.file).push(hunk);
    }
  }

  let html = `
    <section id="section-${esc(section.id)}" class="review-section">
      <div class="section-header">
        <div class="section-header-left">
          <span class="section-number">
            Section ${String(index + 1).padStart(2, "0")}${fileCount > 0 ? ` \u00b7 ${fileCount} file${fileCount !== 1 ? "s" : ""}` : ""}
          </span>
          <h2>${esc(section.title)}</h2>
        </div>
      </div>
      <div class="section-body">
        <div class="narrative">${md(section.narrative)}</div>`;

  if (section.diagram) {
    html += `
        <div class="diagram-container">
          <div class="diagram-label">Diagram</div>
          <div class="mermaid-source">${esc(section.diagram)}</div>
        </div>`;
  }

  if (section.callouts?.length) {
    html += section.callouts.map((c) => renderCallout(c.type, c.label, c.text)).join("");
  }

  if (section.hunks?.length) {
    html += `<div class="hunks">`;
    for (const [filePath, fileHunks] of fileGroups.entries()) {
      html += renderHunkGroup(filePath, fileHunks, section.id, parsedFiles, mode, gitHistory);
    }
    html += `</div>`;
  }

  html += `
      </div>
    </section>`;
  return html;
}

function renderCommitTimeline(gitHistory) {
  const commits = gitHistory?.commits;
  if (!commits?.length) return "";
  return `
    <details class="commit-timeline">
      <summary class="commit-timeline-summary">${commits.length} commit${commits.length > 1 ? "s" : ""} in this PR</summary>
      <ol class="commit-list">${commits.map((c) => `
        <li class="commit-item">
          <code class="commit-sha">${esc(c.sha)}</code>
          <span class="commit-msg">${esc(c.message)}</span>
          <span class="commit-author">${esc(c.author)}</span>
          <span class="commit-date">${new Date(c.date).toLocaleDateString()}</span>
        </li>`).join("")}
      </ol>
    </details>`;
}

function renderReviewsSummary(reviews) {
  if (!reviews?.length) return "";
  const filtered = reviews.filter((r) => r.state !== "PENDING" && r.state !== "DISMISSED");
  if (!filtered.length) return "";
  return `
    <div class="reviews-summary">
      ${filtered.map((r) => {
        const stateClass = r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes-requested" : "commented";
        const stateLabel = r.state === "APPROVED" ? "Approved" : r.state === "CHANGES_REQUESTED" ? "Changes requested" : "Commented";
        return `
          <div class="review-item review-${stateClass}">
            <span class="review-author">${esc(r.user)}</span>
            <span class="review-state">${esc(stateLabel)}</span>
            <span class="review-time">${new Date(r.submittedAt).toLocaleDateString()}</span>
            ${r.body ? `<div class="review-body">${md(r.body)}</div>` : ""}
          </div>`;
      }).join("")}
    </div>`;
}

function renderRemainingChanges(parsedFiles, wt, mode) {
  const coveredFiles = new Set();
  for (const s of wt.sections || []) {
    for (const h of s.hunks || []) coveredFiles.add(h.file);
  }
  const allFiles = Object.keys(parsedFiles);
  const uncovered = allFiles.filter((f) => !coveredFiles.has(f));
  if (uncovered.length === 0) return "";

  const groups = groupFilesByDirectory(uncovered);
  const groupsHtml = groups.map(([dir, files]) => {
    const filesHtml = files.map((filePath) => {
      const file = parsedFiles[filePath];
      const stats = file ? getFileStats(file) : null;
      const fileName = filePath.split("/").pop();
      const diffHtml = file ? renderDiffHtml(file, mode) : "";
      return `
        <div class="remaining-file">
          <details>
            <summary class="remaining-file-header">
              <span class="remaining-file-name">${esc(fileName)}</span>
              ${stats ? `<span class="remaining-file-stats">+${stats.additions} &minus;${stats.deletions}</span>` : ""}
            </summary>
            ${diffHtml ? `<div class="hunk-diff">${diffHtml}</div>` : ""}
          </details>
        </div>`;
    }).join("");
    return `
      <div class="remaining-group">
        <div class="remaining-group-header">
          <span class="hunk-file">${esc(dir || "(root)")}/</span>
          <span class="hunk-count">${files.length} file${files.length > 1 ? "s" : ""}</span>
        </div>
        ${filesHtml}
      </div>`;
  }).join("");

  return `
    <section id="section-remaining" class="review-section remaining-section">
      <div class="section-header">
        <div class="section-header-left">
          <span class="section-number">Remaining Changes</span>
          <h2>${uncovered.length} files not in walkthrough</h2>
        </div>
      </div>
      <div class="section-body">
        <div class="narrative">
          <p>These files were changed in the PR but not featured in the walkthrough above.</p>
        </div>
        ${groupsHtml}
      </div>
    </section>`;
}

function renderFileMap(wt) {
  if (!wt.file_map?.length) return "";
  return `
    <section id="section-file-map">
      <span class="section-number">Appendix</span>
      <h2>File Map</h2>
      <div class="file-tree">
        ${wt.file_map.map((f) => `
          <div class="indent ${f.is_new ? "new-file" : "file"}">${esc(f.path)} &mdash; ${esc(f.description)}</div>`
        ).join("")}
      </div>
    </section>`;
}

function renderFooter(meta) {
  return `
    <footer class="page-footer">
      <p>Generated ${meta.generatedAt ? new Date(meta.generatedAt).toLocaleString() : "just now"}</p>
      ${meta.url ? `<p><a href="${esc(meta.url)}" target="_blank">View on GitHub &#x2197;</a></p>` : ""}
    </footer>`;
}

// ── Inline client-side script ──
// Mirrors logic from DiffView.jsx (injectInlineAnnotations, highlightDiffCode)
// and mermaid.js (renderMermaidIn) to keep behavior in sync.

function getClientScript() {
  return `
// ── md() — same as src/utils.js ──
function md(text) {
  if (!text) return "";
  const codeBlocks = [];
  let result = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
      const i = codeBlocks.length;
      codeBlocks.push('<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' + code.trim() + '</code></pre>');
      return "\\x00CB" + i + "\\x00";
    })
    .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
    .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
    .replace(/\\*([^*]+)\\*/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^## (.+)$/gm, "<h3>$1</h3>")
    .replace(/^# (.+)$/gm, "<h2>$1</h2>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\\/li>\\n?)+/g, (match) => "<ul>" + match + "</ul>")
    .replace(/\\n\\n/g, "</p><p>")
    .replace(/^(?!<[huplo])(.+)$/gm, (_, line) => line.trim() ? "<p>" + line + "</p>" : "")
    .replace(/\\x00CB(\\d+)\\x00/g, (_, i) => codeBlocks[i]);
  return result;
}

// ── Annotation injection — same logic as DiffView.jsx injectInlineAnnotations ──
document.querySelectorAll(".hunk-annotations").forEach(container => {
  const diffView = container.previousElementSibling; // .hunk-diff
  if (!diffView) return;

  // Build map of new-file line numbers to <tr> elements (same as DiffView.jsx:44-51)
  const lineToRow = new Map();
  diffView.querySelectorAll(".line-num2").forEach(el => {
    const num = parseInt(el.textContent);
    if (!isNaN(num)) {
      const row = el.closest("tr");
      if (row) lineToRow.set(num, row);
    }
  });

  if (lineToRow.size === 0) return; // keep fallback blocks visible
  const lineNums = [...lineToRow.keys()].sort((a, b) => a - b);

  // Detect column count (same as DiffView.jsx:57-58)
  const sampleRow = lineToRow.values().next().value;
  const colCount = sampleRow ? sampleRow.querySelectorAll("td").length : 2;

  container.querySelectorAll(".hunk-annotation").forEach(ann => {
    const endLine = parseInt(ann.dataset.targetLine);
    if (isNaN(endLine) || endLine === 0) return;

    // Find closest line at or before endLine (same as DiffView.jsx:66-73)
    let targetLineNum = null;
    for (const num of lineNums) {
      if (num <= endLine) targetLineNum = num;
      else break;
    }
    if (targetLineNum === null && lineNums.length > 0) targetLineNum = lineNums[0];
    if (targetLineNum === null) return;

    const row = lineToRow.get(targetLineNum);
    if (!row) return;

    // If no more changed lines follow in this block, push to end of block
    var tbody = row.closest("tbody");
    var insertAfter = row;
    if (tbody) {
      var rows = Array.from(tbody.rows);
      var targetIdx = rows.indexOf(row);
      var hasMoreChanges = rows.slice(targetIdx + 1).some(function(r) {
        return r.classList.contains("d2h-ins") || r.classList.contains("d2h-del");
      });
      if (!hasMoreChanges) insertAfter = rows[rows.length - 1];
    }

    var annotationRow = document.createElement("tr");
    annotationRow.className = "annotation-row";
    var td = document.createElement("td");
    td.colSpan = colCount;
    var div = document.createElement("div");
    div.className = ann.className.replace("hunk-annotation", "hunk-annotation-inline");
    div.innerHTML = ann.innerHTML;
    td.appendChild(div);
    annotationRow.appendChild(td);
    insertAfter.after(annotationRow);
    ann.remove();
  });

  // Remove container if all annotations were moved inline
  if (container.children.length === 0) container.remove();
});

// ── Syntax highlighting — same approach as DiffView.jsx highlightDiffCode ──
if (window.hljs) {
  // Highlight diff code lines
  document.querySelectorAll(".d2h-code-line-ctn").forEach(el => {
    const text = el.textContent;
    if (!text) return;
    const hunkGroup = el.closest(".hunk-group") || el.closest(".remaining-file");
    const fileEl = hunkGroup?.querySelector(".hunk-file, .remaining-file-name");
    const fileName = fileEl?.textContent || "";
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (!ext || !hljs.getLanguage(ext)) return;
    try {
      const result = hljs.highlight(text, { language: ext, ignoreIllegals: true });
      el.classList.add("hljs");
      el.innerHTML = result.value;
    } catch {}
  });

  // Highlight code blocks in annotations and narrative
  document.querySelectorAll(".hunk-annotation-inline pre code, .hunk-annotation pre code, .narrative pre code").forEach(el => {
    hljs.highlightElement(el);
  });
}

// ── Mermaid — same logic as src/mermaid.js renderMermaidIn ──
function sanitizeMermaid(src) {
  if (!src) return src;
  var NEEDS = /[|#<>"]/;
  return src.split("\\n").map(function(line) {
    var t = line.trim();
    if (!t || /^%%/.test(t) || /^(flowchart|graph|subgraph|end|classDef|style|click|linkStyle|direction)\\b/.test(t)) return line;
    line = line.replace(/\\b([A-Za-z_]\\w*)\\[(?!")([^\\]]+)\\]/g, function(m, id, l) {
      return NEEDS.test(l) ? id + '["' + l.replace(/"/g, '&quot;') + '"]' : m;
    });
    line = line.replace(/\\b([A-Za-z_]\\w*)\\((?!")([^)]+)\\)/g, function(m, id, l) {
      return NEEDS.test(l) ? id + '("' + l.replace(/"/g, '&quot;') + '")' : m;
    });
    line = line.replace(/\\b([A-Za-z_]\\w*)\\{(?!")([^}]+)\\}/g, function(m, id, l) {
      return NEEDS.test(l) ? id + '{"' + l.replace(/"/g, '&quot;') + '"}' : m;
    });
    // Escape inner double-quotes inside already-quoted labels (greedy match for outermost closing quote)
    line = line.replace(/\\b([A-Za-z_]\\w*)\\["(.+)"\\]/g, function(m, id, l) {
      return l.includes('"') ? id + '["' + l.replace(/"/g, '&quot;') + '"]' : m;
    });
    line = line.replace(/\\b([A-Za-z_]\\w*)\\("(.+)"\\)/g, function(m, id, l) {
      return l.includes('"') ? id + '("' + l.replace(/"/g, '&quot;') + '")' : m;
    });
    line = line.replace(/\\b([A-Za-z_]\\w*)\\{"(.+)"\\}/g, function(m, id, l) {
      return l.includes('"') ? id + '{"' + l.replace(/"/g, '&quot;') + '"}' : m;
    });
    return line;
  }).join("\\n");
}

import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs").then(({ default: mermaid }) => {
  mermaid.initialize({
    startOnLoad: false,
    theme: "neutral",
    themeVariables: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: "12px",
      primaryColor: "rgba(82,125,165,0.12)",
      primaryTextColor: "#37352f",
      primaryBorderColor: "#527da5",
      lineColor: "#b4b4b0",
      secondaryColor: "rgba(84,129,100,0.12)",
      tertiaryColor: "rgba(144,101,176,0.12)",
    },
  });
  document.querySelectorAll(".mermaid-source").forEach(async el => {
    var raw = el.textContent.trim().replace(/^\`\`\`(?:mermaid)?\\s*\\n?/, "").replace(/\\n?\`\`\`\\s*$/, "");
    var id = "mermaid-" + Math.random().toString(36).slice(2, 8);
    try {
      try { await mermaid.parse(raw); } catch { raw = sanitizeMermaid(raw); }
      const { svg } = await mermaid.render(id, raw);
      const div = document.createElement("div");
      div.className = "mermaid-rendered";
      div.innerHTML = svg;
      el.replaceWith(div);
    } catch (err) {
      el.classList.add("mermaid-error");
    }
  });
}).catch(() => {});

// ── Sidebar active section tracking ──
const tocLinks = document.querySelectorAll(".static-sidebar .toc a");
const sections = Array.from(document.querySelectorAll("section[id]"));
if (tocLinks.length && sections.length) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        tocLinks.forEach(link => {
          link.parentElement.classList.toggle("active", link.getAttribute("href") === "#" + id);
        });
      }
    }
  }, { rootMargin: "-10% 0px -80% 0px" });
  sections.forEach(s => observer.observe(s));
}
`;
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  let inputPath = null;
  let outputPath = null;
  let mode = "unified";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" || args[i] === "-o") {
      outputPath = args[++i];
    } else if (args[i] === "--mode" || args[i] === "-m") {
      mode = args[++i];
    } else if (!inputPath) {
      inputPath = args[i];
    }
  }

  if (!inputPath) {
    console.error("Usage: node src/export-static.js <slug-or-json-path> [--output path.html] [--mode side-by-side|unified]");
    process.exit(1);
  }

  // Resolve input: could be a slug or a file path
  let jsonPath;
  if (existsSync(inputPath)) {
    jsonPath = resolve(inputPath);
  } else {
    jsonPath = resolve(__dirname, "..", "public", "walkthroughs", `${inputPath}.json`);
    if (!existsSync(jsonPath)) {
      jsonPath = resolve(__dirname, "..", "public", "walkthrough-data.json");
    }
  }

  if (!existsSync(jsonPath)) {
    console.error(`Walkthrough not found: ${inputPath}`);
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const { meta, walkthrough: wt, diff, reviews, gitHistory } = data;

  if (!wt) {
    console.error("Invalid walkthrough data: missing 'walkthrough' field");
    process.exit(1);
  }

  const parsedFiles = diff ? parseDiff(diff) : {};

  // Load CSS
  const appCss = readFileSync(resolve(__dirname, "styles.css"), "utf-8");
  const diff2htmlCssPath = resolve(__dirname, "..", "node_modules", "diff2html", "bundles", "css", "diff2html.min.css");
  const diff2htmlCss = existsSync(diff2htmlCssPath) ? readFileSync(diff2htmlCssPath, "utf-8") : "";

  // Build body content
  const sections = wt.sections || [];
  const mainContent = [
    renderHeader(meta, wt, reviews),
    renderReviewsSummary(reviews),
    renderCommitTimeline(gitHistory),
    renderOverview(wt),
    ...sections.map((s, i) => renderSection(s, i, parsedFiles, mode, gitHistory)),
    renderRemainingChanges(parsedFiles, wt, mode),
    renderFileMap(wt),
    renderFooter(meta),
  ].join("\n");

  const sidebarHtml = renderSidebar(meta, wt, parsedFiles);
  const title = esc(wt.title || "PR Walkthrough");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
<style>
${diff2htmlCss}
${appCss}

/* ── Static export: layout ── */
.static-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  min-height: 100vh;
}

.static-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  background: var(--bg-white);
  border-right: 1px solid var(--border);
  padding: 1.5rem 1rem;
  scrollbar-width: thin;
}

.static-sidebar .sidebar-header-block {
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border-light);
  margin-bottom: 1rem;
}

.static-sidebar .toc {
  background: transparent;
  border: none;
  padding: 0;
  border-radius: 0;
  margin: 0;
}

.static-sidebar .toc::before { display: none; }
.static-sidebar .toc ol { columns: 1; }

.static-sidebar .toc li {
  margin-bottom: 2px;
}

.static-sidebar .toc li.active > a {
  color: var(--blue);
  font-weight: 500;
}

.static-sidebar .toc a {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.static-sidebar .toc a:hover {
  background: var(--bg-hover);
}

.static-sidebar .toc .toc-meta {
  font-size: 10px;
  margin-left: 0;
  padding-left: 1.5em;
}

.static-main {
  overflow-x: hidden;
}

.static-main .page-container {
  max-width: 1100px;
}

/* ── Static export: hide interactive elements ── */
.bottom-bar, .action-panel, .action-panel-backdrop,
.minimap, .review-modal, .shortcuts-modal,
.review-checkbox, .collapse-toggle, .hunk-review-check,
.hunk-toggle-icon, .section-footer,
.comment-composer, .expand-context-bar,
.review-complete-banner, .diff-filter-notice,
.file-review-checkbox { display: none !important; }

.review-section { opacity: 1 !important; }
.review-section:hover { border-color: transparent; }
.section-header { cursor: default; }
.hunk-header { cursor: default; }
.hunk-diff { max-height: none; overflow: visible; }
body { padding-bottom: 0; }

/* ── Static export: annotation fallback blocks ── */
.hunk-annotations {
  border-top: 1px solid var(--border-light);
  width: 100%;
}

/* ── Static export: remaining files ── */
.remaining-file > details > summary {
  cursor: pointer;
  list-style: none;
}
.remaining-file > details > summary::-webkit-details-marker { display: none; }
.remaining-file > details > summary::before {
  content: "\\25b6";
  font-size: 10px;
  color: var(--ink-faint);
  margin-right: 6px;
  display: inline-block;
  transition: transform 0.15s;
}
.remaining-file > details[open] > summary::before {
  transform: rotate(90deg);
}

/* ── Static export: responsive ── */
@media (max-width: 900px) {
  .static-layout {
    grid-template-columns: 1fr;
  }
  .static-sidebar {
    position: relative;
    height: auto;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
}

@media print {
  .static-layout { display: block; }
  .static-sidebar { display: none; }
  .page-container { max-width: none; padding: 0; }
  .review-section { break-inside: avoid; }
  .hunk-group { break-inside: avoid; }
  a[href]::after { content: none; }
}
</style>
</head>
<body>
<div class="static-layout">
${sidebarHtml}
<div class="static-main">
<div class="page-container">
${mainContent}
</div>
</div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/typescript.min.js"><\/script>
<script type="module">
${getClientScript()}
<\/script>
</body>
</html>`;

  if (!outputPath) {
    const slug = basename(jsonPath, ".json");
    outputPath = `${slug}.html`;
  }
  outputPath = resolve(outputPath);

  writeFileSync(outputPath, html);
  console.log(`Static walkthrough exported to: ${outputPath}`);
}

main();
