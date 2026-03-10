import { html as diff2htmlHtml, parse as diff2htmlParse } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import "./styles.css";

// ─── State ───────────────────────────────────────────
let data = null;
let parsedFiles = {};
let reviewState = {}; // { [sectionId]: { reviewed: bool, timestamp } }
let diffViewMode = "side-by-side"; // "side-by-side" | "unified"
let collapsedSections = new Set();
let collapsedHunks = new Set(); // file-level collapse within sections
let pendingComments = []; // { path, line, side, body } — queued for review submission
let showComments = true;
let showFullFile = new Set(); // hunkKeys where user wants to see full file instead of filtered
let fileContentCache = new Map(); // path -> string[] (file lines, for expanding context)
let viewMode = localStorage.getItem("review-tool-view") || "editorial";
let darkMode = localStorage.getItem("review-tool-dark") === "true";
let currentSectionIndex = 0; // for focus-stepper view

let autoCollapseApplied = false; // track whether auto-collapse has been applied for this data

function loadReviewState() {
  try {
    const key = `review-${data?.meta?.url || data?.meta?.title || "local"}`;
    const saved = localStorage.getItem(key);
    if (saved) reviewState = JSON.parse(saved);

    // QW10: Restore collapsed state from localStorage
    const collapseKey = `${key}:collapsed`;
    const savedCollapse = localStorage.getItem(collapseKey);
    if (savedCollapse) {
      const parsed = JSON.parse(savedCollapse);
      collapsedSections = new Set(parsed.sections || []);
      collapsedHunks = new Set(parsed.hunks || []);
      autoCollapseApplied = true; // user has saved state, skip auto-collapse
    }
  } catch {
    /* ignore */
  }
}

function saveReviewState() {
  try {
    const key = `review-${data?.meta?.url || data?.meta?.title || "local"}`;
    localStorage.setItem(key, JSON.stringify(reviewState));

    // QW10: Save collapsed state
    const collapseKey = `${key}:collapsed`;
    localStorage.setItem(collapseKey, JSON.stringify({
      sections: [...collapsedSections],
      hunks: [...collapsedHunks],
    }));
  } catch {
    /* ignore */
  }
}

// QW2: Auto-collapse supporting and context hunks on first load
function applyAutoCollapse() {
  if (autoCollapseApplied || !data?.walkthrough?.sections) return;
  autoCollapseApplied = true;

  for (const section of data.walkthrough.sections) {
    if (!section.hunks?.length) continue;

    // Group hunks by file (same logic as renderGroupedHunks)
    const fileGroups = new Map();
    for (const hunk of section.hunks) {
      if (!fileGroups.has(hunk.file)) fileGroups.set(hunk.file, []);
      fileGroups.get(hunk.file).push(hunk);
    }

    for (const [filePath, fileHunks] of fileGroups) {
      const importanceOrder = { critical: 0, important: 1, supporting: 2, context: 3 };
      const topImportance = fileHunks.reduce((best, h) => {
        const hImp = h.importance || "important";
        return (importanceOrder[hImp] || 2) < (importanceOrder[best] || 2) ? hImp : best;
      }, fileHunks[0].importance || "important");

      // Auto-collapse supporting and context hunks
      if (topImportance === "supporting" || topImportance === "context") {
        collapsedHunks.add(`${section.id}:${filePath}`);
      }
    }
  }
}

// ─── Diff Parsing ────────────────────────────────────
function parseDiff(rawDiff) {
  const files = diff2htmlParse(rawDiff);
  const byFile = {};
  for (const file of files) {
    // Normalize name — strip leading a/ or b/ prefixes if needed
    const name = file.isDeleted ? file.oldName : file.newName || file.oldName;
    byFile[name] = file;
  }
  return byFile;
}

function findFile(path) {
  // Try exact match first, then try partial matches
  if (parsedFiles[path]) return parsedFiles[path];
  // Try without leading slash
  const stripped = path.replace(/^\//, "");
  if (parsedFiles[stripped]) return parsedFiles[stripped];
  // Try matching end of path
  for (const [key, file] of Object.entries(parsedFiles)) {
    if (key.endsWith(path) || path.endsWith(key)) return file;
  }
  return null;
}

function renderFileDiff(file, mode) {
  if (!file) return '<div class="no-diff">File not found in diff</div>';
  return diff2htmlHtml([file], {
    drawFileList: false,
    matching: "lines",
    outputFormat: mode === "unified" ? "line-by-line" : "side-by-side",
    rawTemplates: {},
  });
}

// Filter a diff2html file to only include blocks overlapping the given line ranges.
// Each range is { startLine, endLine } referencing new-file line numbers.
// Returns a shallow copy with filtered blocks, or the original if no ranges given.
function filterFileToRanges(file, ranges) {
  if (!file || !ranges || ranges.length === 0) return file;

  // Expand each range by a small context margin to capture nearby blocks
  const CONTEXT = 5;
  const expanded = ranges
    .filter((r) => r.startLine && r.endLine)
    .map((r) => ({ start: r.startLine - CONTEXT, end: r.endLine + CONTEXT }));

  if (expanded.length === 0) return file;

  const filtered = file.blocks.filter((block) => {
    // Compute the new-file line range this block covers
    const blockStart = block.newStartLine;
    let blockEnd = blockStart;
    for (const line of block.lines) {
      if (line.newNumber) blockEnd = Math.max(blockEnd, line.newNumber);
    }
    // Keep block if it overlaps any requested range
    return expanded.some((r) => blockStart <= r.end && blockEnd >= r.start);
  });

  if (filtered.length === file.blocks.length) return file;

  return {
    ...file,
    blocks: filtered,
    // Recount added/deleted from filtered blocks
    addedLines: filtered.reduce((n, b) => n + b.lines.filter((l) => l.type === "insert").length, 0),
    deletedLines: filtered.reduce((n, b) => n + b.lines.filter((l) => l.type === "delete").length, 0),
  };
}

// ─── File Content (for expanding context) ────────────
async function fetchFileContent(filePath) {
  if (fileContentCache.has(filePath)) return fileContentCache.get(filePath);
  if (!isGitHubPR()) return null;
  const { owner, repo, headBranch } = data.meta;
  try {
    const result = await ghApi("GET", `repos/${owner}/${repo}/contents/${filePath}`, { ref: headBranch });
    const base64 = (result.content || "").replace(/\n/g, "");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const content = new TextDecoder().decode(bytes);
    const lines = content.split("\n");
    fileContentCache.set(filePath, lines);
    return lines;
  } catch (err) {
    console.warn("Failed to fetch file content:", filePath, err);
    return null;
  }
}

function getBlockEndLines(block) {
  let lastNew = block.newStartLine;
  let lastOld = block.oldStartLine;
  for (const line of block.lines) {
    if (line.newNumber) lastNew = Math.max(lastNew, line.newNumber);
    if (line.oldNumber) lastOld = Math.max(lastOld, line.oldNumber);
  }
  return { lastNew, lastOld };
}

async function expandContext(filePath, direction, blockNewStart) {
  const file = findFile(filePath);
  if (!file) return;

  const fileLines = await fetchFileContent(filePath);
  if (!fileLines) return;

  const EXPAND_COUNT = 20;

  if (direction === "up") {
    const block = file.blocks.find((b) => b.newStartLine === blockNewStart) || file.blocks[0];
    if (!block || block.newStartLine <= 1) return;

    const blockIdx = file.blocks.indexOf(block);
    let minNew = 1;
    if (blockIdx > 0) {
      const { lastNew } = getBlockEndLines(file.blocks[blockIdx - 1]);
      minNew = lastNew + 1;
    }
    const expandFrom = Math.max(minNew, block.newStartLine - EXPAND_COUNT);
    if (expandFrom >= block.newStartLine) return;

    const oldOffset = block.oldStartLine - block.newStartLine;
    const newLines = [];
    for (let i = expandFrom; i < block.newStartLine; i++) {
      newLines.push({
        type: "context",
        content: " " + (fileLines[i - 1] ?? ""),
        oldNumber: i + oldOffset > 0 ? i + oldOffset : null,
        newNumber: i,
      });
    }
    block.lines = [...newLines, ...block.lines];
    block.newStartLine = expandFrom;
    block.oldStartLine = expandFrom + oldOffset > 0 ? expandFrom + oldOffset : 1;
  } else if (direction === "down") {
    const lastBlock = file.blocks[file.blocks.length - 1];
    if (!lastBlock) return;
    const block = blockNewStart
      ? file.blocks.find((b) => b.newStartLine === blockNewStart) || lastBlock
      : lastBlock;

    const { lastNew, lastOld } = getBlockEndLines(block);
    const blockIdx = file.blocks.indexOf(block);
    let maxNew = fileLines.length;
    if (blockIdx < file.blocks.length - 1) {
      maxNew = file.blocks[blockIdx + 1].newStartLine - 1;
    }
    const expandTo = Math.min(maxNew, lastNew + EXPAND_COUNT);
    if (expandTo <= lastNew) return;

    const oldOffset = lastOld - lastNew;
    for (let i = lastNew + 1; i <= expandTo; i++) {
      block.lines.push({
        type: "context",
        content: " " + (fileLines[i - 1] ?? ""),
        oldNumber: i + oldOffset,
        newNumber: i,
      });
    }
  } else if (direction === "between") {
    const blockIdx = file.blocks.findIndex((b) => b.newStartLine === blockNewStart);
    if (blockIdx <= 0) return;

    const prevBlock = file.blocks[blockIdx - 1];
    const nextBlock = file.blocks[blockIdx];
    const { lastNew: prevEndNew, lastOld: prevEndOld } = getBlockEndLines(prevBlock);

    const gapStart = prevEndNew + 1;
    const gapEnd = nextBlock.newStartLine - 1;
    if (gapStart > gapEnd) return;

    const oldOffset = prevEndOld - prevEndNew;
    for (let i = gapStart; i <= gapEnd; i++) {
      prevBlock.lines.push({
        type: "context",
        content: " " + (fileLines[i - 1] ?? ""),
        oldNumber: i + oldOffset,
        newNumber: i,
      });
    }
    prevBlock.lines.push(...nextBlock.lines);
    file.blocks.splice(blockIdx, 1);
  }

  render();
}

// ─── Jump to Definition ──────────────────────────────
function findDefinitionsInDiff(identifier) {
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

function getWordAtPoint(event) {
  const range = document.caretRangeFromPoint
    ? document.caretRangeFromPoint(event.clientX, event.clientY)
    : null;
  if (!range) return null;
  const text = range.startContainer.textContent || "";
  const offset = range.startOffset;
  const wordRe = /[a-zA-Z_$][a-zA-Z0-9_$]*/g;
  let match;
  while ((match = wordRe.exec(text)) !== null) {
    if (match.index <= offset && offset <= match.index + match[0].length) {
      return match[0];
    }
  }
  return null;
}

function navigateToDefinition(result) {
  const { filePath, line: lineNum } = result;
  const targetFile = findFile(filePath);

  for (const section of data?.walkthrough?.sections || []) {
    const hunk = (section.hunks || []).find((h) => findFile(h.file) === targetFile);
    if (hunk) {
      collapsedSections.delete(section.id);
      const hunkKey = `${section.id}:${hunk.file}`;
      collapsedHunks.delete(hunkKey);
      render();
      requestAnimationFrame(() => highlightLineInDiff(lineNum));
      return;
    }
  }

  // Check remaining changes
  collapsedSections.delete("__remaining");
  const actualPath = Object.keys(parsedFiles).find((k) => parsedFiles[k] === targetFile);
  if (actualPath) {
    const fileKey = `__remaining:file:${actualPath}`;
    collapsedHunks.add(fileKey);
    render();
    requestAnimationFrame(() => highlightLineInDiff(lineNum));
  }
}

function highlightLineInDiff(lineNum) {
  if (!lineNum) return;
  const cells = document.querySelectorAll(".d2h-code-side-linenumber, .d2h-code-linenumber");
  for (const cell of cells) {
    if (cell.textContent.trim() === String(lineNum)) {
      const row = cell.closest("tr");
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.add("jump-highlight");
        setTimeout(() => row.classList.remove("jump-highlight"), 2500);
        return;
      }
    }
  }
}

function showJumpPopup(results, x, y) {
  document.querySelector(".jump-popup")?.remove();
  if (!results.length) return;
  if (results.length === 1) {
    navigateToDefinition(results[0]);
    return;
  }
  const popup = document.createElement("div");
  popup.className = "jump-popup";
  popup.style.left = x + "px";
  popup.style.top = y + "px";
  popup.innerHTML = results
    .map(
      (r, i) => `
    <div class="jump-popup-item" data-jump-idx="${i}">
      <span class="jump-popup-file">${esc(r.filePath.split("/").pop())}</span>
      <span class="jump-popup-line">L${r.line}</span>
    </div>`
    )
    .join("");
  document.body.appendChild(popup);
  const close = (e) => {
    if (!popup.contains(e.target)) {
      popup.remove();
      document.removeEventListener("click", close);
    }
  };
  setTimeout(() => document.addEventListener("click", close), 0);
  popup.querySelectorAll(".jump-popup-item").forEach((item) => {
    item.addEventListener("click", () => {
      navigateToDefinition(results[parseInt(item.dataset.jumpIdx)]);
      popup.remove();
    });
  });
}

// ─── Section Helpers ─────────────────────────────────

// QW1: Estimate reading time for a section (narrative + code)
function getEstimatedReadTime(section) {
  let wordCount = 0;
  let codeLines = 0;

  // Count words in narrative
  if (section.narrative) {
    wordCount += section.narrative.split(/\s+/).length;
  }

  // Count words in callouts
  for (const c of section.callouts || []) {
    if (c.text) wordCount += c.text.split(/\s+/).length;
  }

  // Count code lines from hunks
  for (const hunk of section.hunks || []) {
    const file = findFile(hunk.file);
    if (file) {
      for (const block of file.blocks || []) {
        codeLines += block.lines?.length || 0;
      }
    }
    if (hunk.annotation) wordCount += hunk.annotation.split(/\s+/).length;
  }

  // ~200 words/min for prose, ~30 lines/min for code review
  const minutes = wordCount / 200 + codeLines / 30;
  return Math.max(1, Math.round(minutes));
}

// QW7: Count comments for files in a section's hunks
function getCommentCountForSection(section) {
  if (!data?.comments?.length || !section.hunks?.length) return 0;
  const sectionFiles = new Set(section.hunks.map((h) => h.file));
  return data.comments.filter((c) =>
    [...sectionFiles].some((f) => f === c.path || f.endsWith(c.path) || c.path.endsWith(f))
  ).length;
}

// ─── Mermaid ─────────────────────────────────────────
let mermaidLoaded = false;
let mermaidLoading = null;

async function loadMermaid() {
  if (mermaidLoaded) return;
  if (mermaidLoading) return mermaidLoading;

  mermaidLoading = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    script.onload = () => {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: "neutral",
        themeVariables: {
          fontFamily: "'DM Mono', monospace",
          fontSize: "12px",
          primaryColor: "#2d5f8a22",
          primaryTextColor: "#1a1a18",
          primaryBorderColor: "#2d5f8a",
          lineColor: "#8a8578",
          secondaryColor: "#3a7d4422",
          tertiaryColor: "#6a4c9322",
        },
      });
      mermaidLoaded = true;
      resolve();
    };
    document.head.appendChild(script);
  });

  return mermaidLoading;
}

async function renderMermaid(container) {
  if (!mermaidLoaded) await loadMermaid();
  const els = container.querySelectorAll(".mermaid-source");
  for (const el of els) {
    const id = `mermaid-${Math.random().toString(36).slice(2, 8)}`;
    try {
      // Strip ```mermaid fences if the AI included them
      const raw = el.textContent.trim().replace(/^```(?:mermaid)?\s*\n?/, "").replace(/\n?```\s*$/, "");
      const { svg } = await window.mermaid.render(id, raw);
      const div = document.createElement("div");
      div.className = "mermaid-rendered";
      div.innerHTML = svg;
      el.replaceWith(div);
    } catch (err) {
      console.warn("Mermaid render failed:", err);
      el.classList.add("mermaid-error");
      el.textContent = `Diagram error: ${err.message}\n\n${el.textContent}`;
    }
  }
}

// ─── Markdown (minimal) ──────────────────────────────
function md(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
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
    );
}

// ─── GitHub API ──────────────────────────────────────
function isGitHubPR() {
  return data?.meta?.source === "github" && data?.meta?.owner && data?.meta?.repo && data?.meta?.number;
}

async function ghApi(method, endpoint, body) {
  const resp = await fetch("/api/gh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, endpoint, data: body }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || err.stderr || "GitHub API error");
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

function getCommentsForFile(filePath) {
  if (!data?.comments?.length) return [];
  return data.comments.filter((c) => c.path === filePath || filePath.endsWith(c.path) || c.path.endsWith(filePath));
}

function getCommentThreads(filePath) {
  const comments = getCommentsForFile(filePath);
  // Group by thread: top-level comments + their replies
  const topLevel = comments.filter((c) => !c.inReplyToId);
  const replies = comments.filter((c) => c.inReplyToId);

  return topLevel.map((c) => ({
    ...c,
    replies: replies.filter((r) => r.inReplyToId === c.id).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
  }));
}

async function postComment(path, line, side, body) {
  if (!isGitHubPR()) return;
  const { owner, repo, number } = data.meta;

  const result = await ghApi("POST", `repos/${owner}/${repo}/pulls/${number}/comments`, {
    body,
    path,
    line: String(line),
    side: side || "RIGHT",
    commit_id: "", // gh will use the latest commit
  });

  // Add to local data
  data.comments.push({
    id: result.id,
    path,
    line,
    side: side || "RIGHT",
    body,
    user: "you",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    inReplyToId: null,
    diffHunk: "",
  });

  return result;
}

async function submitReview(event, body) {
  if (!isGitHubPR()) return;
  const { owner, repo, number } = data.meta;

  const result = await ghApi("POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, {
    body: body || "",
    event, // APPROVE, REQUEST_CHANGES, COMMENT
  });

  data.reviews.push({
    id: result.id,
    user: "you",
    state: event === "APPROVE" ? "APPROVED" : event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED",
    body: body || "",
    submittedAt: new Date().toISOString(),
  });

  return result;
}

async function refreshComments() {
  if (!isGitHubPR()) return;
  const { owner, repo, number } = data.meta;

  try {
    const comments = await ghApi("GET", `repos/${owner}/${repo}/pulls/${number}/comments`);
    data.comments = comments.map((c) => ({
      id: c.id,
      path: c.path,
      line: c.line || c.original_line,
      side: c.side || "RIGHT",
      body: c.body,
      user: c.user?.login,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      inReplyToId: c.in_reply_to_id || null,
      diffHunk: c.diff_hunk,
    }));

    const reviews = await ghApi("GET", `repos/${owner}/${repo}/pulls/${number}/reviews`);
    data.reviews = reviews.map((r) => ({
      id: r.id,
      user: r.user?.login,
      state: r.state,
      body: r.body,
      submittedAt: r.submitted_at,
    }));

    render();
  } catch (err) {
    console.error("Failed to refresh comments:", err);
  }
}

// ─── Progress ────────────────────────────────────────
function getProgress() {
  if (!data?.walkthrough?.sections) return { reviewed: 0, total: 0, pct: 0 };
  // Count sections + remaining files section (if any)
  const sectionIds = data.walkthrough.sections.map((s) => s.id);
  const coverage = getFileCoverage(data.walkthrough);
  if (coverage.uncovered.length > 0) sectionIds.push("__remaining");
  const total = sectionIds.length;
  const reviewed = sectionIds.filter((id) => reviewState[id]?.reviewed).length;
  return { reviewed, total, pct: total ? Math.round((reviewed / total) * 100) : 0 };
}

// ─── File Coverage ───────────────────────────────────
function getFileCoverage(wt) {
  // All files in the diff
  const allFiles = Object.keys(parsedFiles);

  // Files referenced in walkthrough hunks
  const coveredSet = new Set();
  if (wt?.sections) {
    for (const section of wt.sections) {
      for (const hunk of section.hunks || []) {
        // Match using the same logic as findFile
        const found = findFile(hunk.file);
        if (found) {
          // Find the actual key in parsedFiles
          for (const key of allFiles) {
            if (parsedFiles[key] === found) {
              coveredSet.add(key);
              break;
            }
          }
        }
      }
    }
  }

  const covered = allFiles.filter((f) => coveredSet.has(f));
  const uncovered = allFiles.filter((f) => !coveredSet.has(f));

  // Files with comments that aren't in any walkthrough section
  const commentedFiles = new Set((data?.comments || []).map((c) => c.path));
  const orphanedCommentFiles = [...commentedFiles].filter(
    (f) => !coveredSet.has(f) && !allFiles.some((af) => af === f || af.endsWith(f) || f.endsWith(af))
  );

  return {
    total: allFiles.length,
    covered,
    uncovered,
    coveredCount: covered.length,
    uncoveredCount: uncovered.length,
    pct: allFiles.length ? Math.round((covered.length / allFiles.length) * 100) : 100,
    orphanedCommentFiles,
  };
}

// ─── Rendering ───────────────────────────────────────
// ─── View Registry ───────────────────────────────────
const viewLayouts = {
  editorial: renderEditorialLayout,
  sidebar: renderSidebarLayout,
  focus: renderFocusLayout,
  split: renderSplitLayout,
  developer: renderDeveloperLayout,
  dashboard: renderDashboardLayout,
};

function render() {
  const app = document.getElementById("app");
  const scrollY = window.scrollY;

  // Apply dark mode
  document.documentElement.classList.toggle("dark", darkMode || viewMode === "developer");

  // Apply view mode class
  document.documentElement.className = document.documentElement.className
    .replace(/\bview-\w+\b/g, "").trim();
  document.documentElement.classList.add(`view-${viewMode}`);

  if (!data) {
    app.innerHTML = renderLanding();
    setupLandingHandlers();
    return;
  }

  const layoutFn = viewLayouts[viewMode] || viewLayouts.editorial;
  app.innerHTML = layoutFn();

  setupHandlers();
  renderMermaid(app);

  // Restore scroll position (not meaningful for focus mode)
  if (viewMode !== "focus") {
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  }
}

function getViewData() {
  const { walkthrough: wt, meta } = data;
  return { wt, meta, progress: getProgress(), coverage: getFileCoverage(wt) };
}

function renderEditorialLayout() {
  const { wt, meta, progress, coverage } = getViewData();
  return `
    <div class="page-container">
      ${renderHeader(wt, meta, progress)}
      ${renderProgressBar(progress)}
      ${renderCoverageBar(coverage)}
      ${renderToolbar()}
      ${renderReviewsSummary()}
      ${renderTOC(wt, coverage)}
      ${renderOverview(wt)}
      ${renderSections(wt)}
      ${renderRemainingChanges(coverage)}
      ${renderOrphanedComments(coverage)}
      ${renderReviewCompleteBanner(progress)}
      ${renderFileMap(wt)}
      ${renderFooter(meta)}
    </div>
    ${renderMinimap(wt)}
    ${renderReviewModal()}
  `;
}

function renderSidebarLayout() {
  const { wt, meta, progress, coverage } = getViewData();
  return `
    <div class="layout-sidebar">
      <aside class="sidebar-panel">
        <div class="sidebar-header-block">
          <div class="kicker">Review</div>
          <h3 style="font-family:var(--display);font-weight:400;font-size:1rem;margin:0.25rem 0">${esc(wt.title)}</h3>
          <div class="meta" style="margin-top:0.5rem">${meta.headBranch} → ${meta.baseBranch}</div>
        </div>
        ${renderProgressBar(progress)}
        ${renderTOC(wt, coverage)}
        ${renderSidebarFileTree(coverage)}
      </aside>
      <div class="sidebar-main">
        <div class="page-container" style="max-width:920px">
          ${renderCoverageBar(coverage)}
          ${renderToolbar()}
          ${renderReviewsSummary()}
          ${renderOverview(wt)}
          ${renderSections(wt)}
          ${renderRemainingChanges(coverage)}
          ${renderOrphanedComments(coverage)}
          ${renderFileMap(wt)}
          ${renderFooter(meta)}
        </div>
      </div>
    </div>
    ${renderReviewModal()}
  `;
}

function renderSidebarFileTree(coverage) {
  if (!coverage) return "";
  const allFiles = [...(coverage.covered || []), ...(coverage.uncovered || [])].sort();
  const groups = groupFilesByDirectory(allFiles);
  let html = '<div class="sidebar-files"><div class="sidebar-section-title">Files</div>';
  for (const [dir, files] of groups) {
    html += `<div class="sidebar-dir">${esc(dir || "(root)")}/</div>`;
    for (const f of files) {
      const isCovered = coverage.covered?.includes(f);
      const isReviewed = reviewState[`file:${f}`]?.reviewed;
      const dotClass = isReviewed ? "reviewed" : isCovered ? "covered" : "uncovered";
      const name = f.split("/").pop();
      const file = parsedFiles[f];
      const stats = file ? getFileStats(file) : null;
      html += `<div class="sidebar-file"><span class="sidebar-dot ${dotClass}"></span><span class="sidebar-fname">${esc(name)}</span>${stats ? `<span class="sidebar-fstats">+${stats.additions} −${stats.deletions}</span>` : ""}</div>`;
    }
  }
  html += "</div>";
  return html;
}

function renderFocusLayout() {
  const { wt, meta, progress, coverage } = getViewData();
  const sections = wt.sections || [];
  const totalSteps = sections.length + (coverage.uncoveredCount > 0 ? 1 : 0) + 1; // +1 for overview, +1 for remaining
  const idx = Math.min(currentSectionIndex, totalSteps - 1);

  let sectionHtml;
  if (idx === 0) {
    sectionHtml = renderOverview(wt);
  } else if (idx <= sections.length) {
    sectionHtml = renderSection(sections[idx - 1], idx - 1);
  } else {
    sectionHtml = renderRemainingChanges(coverage);
  }

  const stepDots = [`<span class="focus-dot ${idx === 0 ? "active" : ""}" data-focus-step="0" title="Overview">○</span>`];
  sections.forEach((s, i) => {
    const reviewed = reviewState[s.id]?.reviewed;
    stepDots.push(`<span class="focus-dot ${idx === i + 1 ? "active" : ""} ${reviewed ? "reviewed" : ""}" data-focus-step="${i + 1}" title="${esc(s.title)}">${i + 1}</span>`);
  });
  if (coverage.uncoveredCount > 0) {
    stepDots.push(`<span class="focus-dot ${idx === sections.length + 1 ? "active" : ""}" data-focus-step="${sections.length + 1}" title="Remaining">+</span>`);
  }

  return `
    <div class="layout-focus">
      <div class="focus-topbar">
        <span class="focus-title">${esc(wt.title)}</span>
        <span class="focus-meta">${meta.changedFiles} files · +${meta.additions} −${meta.deletions}</span>
        <span style="flex:1"></span>
        <div class="focus-dots">${stepDots.join("")}</div>
        <span style="flex:1"></span>
        ${renderViewSwitcher()}
        <button class="btn btn-sm btn-icon" id="btn-dark-mode" title="Toggle dark mode">${darkMode ? "☀" : "☾"}</button>
      </div>
      <div class="focus-content">
        <div class="page-container" style="max-width:900px">
          ${sectionHtml}
          <div class="focus-bottom-nav">
            <button class="btn" id="btn-prev-section" ${idx === 0 ? "disabled" : ""}>← Previous</button>
            <span class="focus-counter">${idx + 1} / ${totalSteps}</span>
            <button class="btn btn-primary" id="btn-next-section" ${idx >= totalSteps - 1 ? "disabled" : ""}>Next →</button>
          </div>
        </div>
      </div>
    </div>
    ${renderReviewModal()}
  `;
}

function renderSplitLayout() {
  const { wt, meta, progress, coverage } = getViewData();
  const sections = wt.sections || [];

  let leftHtml = "";
  let rightHtml = "";

  // Overview
  leftHtml += `<div class="split-section" data-split-section="overview"><div class="narrative">${md(wt.overview)}</div></div>`;
  rightHtml += `<div class="split-section" data-split-section="overview">`;
  if (wt.architecture_diagram) {
    rightHtml += `<div class="diagram-container"><div class="diagram-label">Architecture</div><div class="mermaid-source">${esc(wt.architecture_diagram)}</div></div>`;
  }
  rightHtml += `</div>`;

  for (const s of sections) {
    const reviewed = reviewState[s.id]?.reviewed;
    // Left: narrative + callouts
    leftHtml += `<div class="split-section ${reviewed ? "reviewed" : ""}" data-split-section="${esc(s.id)}">`;
    leftHtml += `<span class="section-number">${esc(s.title)}</span>`;
    leftHtml += `<div class="narrative">${md(s.narrative)}</div>`;
    if (s.callouts?.length) {
      for (const c of s.callouts) {
        leftHtml += `<div class="callout ${esc(c.type)}"><span class="callout-label">${esc(c.label)}</span>${md(c.text)}</div>`;
      }
    }
    leftHtml += `<label class="review-checkbox"><input type="checkbox" ${reviewed ? "checked" : ""} data-section-review="${esc(s.id)}" /><span class="review-checkbox-label">${reviewed ? "Reviewed ✓" : "Mark reviewed"}</span></label>`;
    leftHtml += `</div>`;

    // Right: diffs
    rightHtml += `<div class="split-section" data-split-section="${esc(s.id)}">`;
    if (s.hunks?.length) {
      rightHtml += renderGroupedHunks(s.hunks, s.id);
    }
    rightHtml += `</div>`;
  }

  return `
    <div class="layout-split">
      <div class="split-header">
        <div class="page-container">
          ${renderHeader(wt, meta, progress)}
          ${renderToolbar()}
        </div>
      </div>
      <div class="split-panes">
        <div class="split-left">${leftHtml}</div>
        <div class="split-right">${rightHtml}</div>
      </div>
    </div>
    ${renderReviewModal()}
  `;
}

function renderDeveloperLayout() {
  // Same as editorial but CSS makes it compact/monospace. Dark mode forced.
  return renderEditorialLayout();
}

function renderDashboardLayout() {
  const { wt, meta, progress, coverage } = getViewData();
  const sections = wt.sections || [];

  let cardsHtml = "";
  for (const [i, s] of sections.entries()) {
    const reviewed = reviewState[s.id]?.reviewed;
    const fileCount = new Set(s.hunks?.map((h) => h.file) || []).size;
    const topImp = s.hunks?.find((h) => h.importance === "critical") ? "critical" : s.hunks?.find((h) => h.importance === "important") ? "important" : "supporting";
    cardsHtml += `
      <div class="dashboard-card ${reviewed ? "reviewed" : ""}" data-dashboard-section="${i}">
        <div class="dashboard-card-header">
          <span class="dashboard-num">${String(i + 1).padStart(2, "0")}</span>
          <span class="dashboard-status ${reviewed ? "done" : ""}">${reviewed ? "✓" : "○"}</span>
        </div>
        <h3 class="dashboard-card-title">${esc(s.title)}</h3>
        <div class="dashboard-card-meta">
          <span class="hunk-importance importance-badge-${topImp}">${topImp}</span>
          <span>${fileCount} file${fileCount !== 1 ? "s" : ""}</span>
          <span>${s.hunks?.length || 0} hunks</span>
        </div>
      </div>
    `;
  }

  if (coverage.uncoveredCount > 0) {
    const revRemaining = reviewState["__remaining"]?.reviewed;
    cardsHtml += `
      <div class="dashboard-card remaining ${revRemaining ? "reviewed" : ""}">
        <div class="dashboard-card-header">
          <span class="dashboard-num">+</span>
          <span class="dashboard-status ${revRemaining ? "done" : ""}">${revRemaining ? "✓" : "○"}</span>
        </div>
        <h3 class="dashboard-card-title">Remaining Changes</h3>
        <div class="dashboard-card-meta"><span>${coverage.uncoveredCount} files not in walkthrough</span></div>
      </div>
    `;
  }

  return `
    <div class="page-container">
      ${renderHeader(wt, meta, progress)}
      ${renderProgressBar(progress)}
      ${renderCoverageBar(coverage)}
      ${renderToolbar()}
      ${renderReviewsSummary()}
      <div class="dashboard-grid">${cardsHtml}</div>
      ${renderFileMap(wt)}
      ${renderFooter(meta)}
    </div>
    ${renderReviewModal()}
  `;
}

function renderLanding() {
  return `
    <div class="page-container">
      <div class="landing">
        <div class="landing-header">
          <div class="kicker">Review Tool</div>
          <h1>Interactive PR Walkthrough</h1>
          <p class="subtitle">AI-narrated code review that structures your PR diff into a readable, reviewable narrative.</p>
        </div>

        <div class="landing-options">
          <div class="landing-card">
            <h3>GitHub PR</h3>
            <p>Enter a GitHub PR URL to generate an interactive walkthrough.</p>
            <div class="input-group">
              <input type="text" id="pr-url" placeholder="https://github.com/owner/repo/pull/123" />
              <button id="btn-fetch-pr" class="btn btn-primary">Generate</button>
            </div>
          </div>

          <div class="landing-card">
            <h3>Load Existing</h3>
            <p>Load a previously generated walkthrough JSON file.</p>
            <div class="input-group">
              <input type="file" id="file-input" accept=".json" />
              <button id="btn-load-file" class="btn">Load</button>
            </div>
          </div>

          <div class="landing-card">
            <h3>Demo</h3>
            <p>Try with a sample walkthrough to see how the tool works.</p>
            <button id="btn-demo" class="btn">Load Demo</button>
          </div>
        </div>

        <div class="landing-help">
          <h4>Quick Start</h4>
          <pre><code>node src/generate.js https://github.com/owner/repo/pull/123</code></pre>
          <p>Then refresh this page — the walkthrough loads automatically.</p>
        </div>
      </div>
    </div>
  `;
}

function renderHeader(wt, meta, progress) {
  // QW8: Show PR author and reviewer names
  const author = meta.author ? `<span class="meta-item meta-author">by ${esc(meta.author)}</span>` : "";
  const reviewerNames = (data?.reviews || [])
    .filter((r) => r.state !== "PENDING" && r.state !== "DISMISSED" && r.user)
    .map((r) => r.user)
    .filter((v, i, a) => a.indexOf(v) === i); // unique
  const reviewers = reviewerNames.length
    ? `<span class="meta-item meta-reviewers">Reviewers: ${reviewerNames.map((n) => esc(n)).join(", ")}</span>`
    : "";

  return `
    <header class="page-header">
      <div class="kicker">Code Review Walkthrough</div>
      <h1>${esc(wt.title)}</h1>
      <p class="subtitle">${esc(wt.subtitle)}</p>
      <div class="meta">
        ${author}
        ${meta.url ? `<span class="meta-item"><a href="${esc(meta.url)}" target="_blank">PR Link ↗</a></span>` : ""}
        <span class="meta-item">${esc(meta.headBranch)} → ${esc(meta.baseBranch)}</span>
        <span class="meta-item">+${meta.additions} −${meta.deletions}</span>
        <span class="meta-item">${meta.changedFiles} files</span>
        <span class="meta-item review-status ${progress.pct === 100 ? "complete" : ""}">${progress.reviewed}/${progress.total} sections reviewed</span>
        ${reviewers}
      </div>
    </header>
  `;
}

function renderProgressBar(progress) {
  return `
    <div class="progress-bar-container">
      <div class="progress-bar" style="width: ${progress.pct}%"></div>
      <span class="progress-label">${progress.pct}% reviewed</span>
    </div>
  `;
}

function renderCoverageBar(coverage) {
  if (coverage.total === 0) return "";
  const narrated = coverage.pct;
  return `
    <div class="coverage-bar">
      <div class="coverage-indicator">
        <span class="coverage-label">${coverage.coveredCount}/${coverage.total} files narrated</span>
        ${coverage.uncoveredCount > 0 ? `<span class="coverage-remaining">${coverage.uncoveredCount} in Remaining Changes below</span>` : '<span class="coverage-complete">All files covered in walkthrough</span>'}
      </div>
    </div>
  `;
}

function renderToolbar() {
  const commentCount = data?.comments?.length || 0;
  const gh = isGitHubPR();

  return `
    <div class="toolbar">
      <div class="toolbar-group">
        <button class="btn btn-sm ${diffViewMode === "side-by-side" ? "active" : ""}" data-mode="side-by-side">Split</button>
        <button class="btn btn-sm ${diffViewMode === "unified" ? "active" : ""}" data-mode="unified">Unified</button>
      </div>
      <div class="toolbar-group">
        <button class="btn btn-sm" id="btn-expand-all">Expand All</button>
        <button class="btn btn-sm" id="btn-collapse-all">Collapse All</button>
      </div>
      <div class="toolbar-group">
        <button class="btn btn-sm ${showComments ? "active" : ""}" id="btn-toggle-comments">
          Comments${commentCount ? ` (${commentCount})` : ""}
        </button>
        ${gh ? `<button class="btn btn-sm" id="btn-refresh-comments">↻ Refresh</button>` : ""}
      </div>
      ${gh ? `
      <div class="toolbar-group toolbar-review-actions">
        <button class="btn btn-sm btn-approve" id="btn-approve">Approve</button>
        <button class="btn btn-sm btn-request-changes" id="btn-request-changes">Request Changes</button>
      </div>
      ` : ""}
      <div class="toolbar-group">
        <button class="btn btn-sm" id="btn-reset-review">Reset Review</button>
      </div>
      ${renderViewSwitcher()}
      <button class="btn btn-sm btn-icon" id="btn-dark-mode" title="Toggle dark mode">${darkMode ? "☀" : "☾"}</button>
      <div class="toolbar-hint">
        <kbd>j</kbd>/<kbd>k</kbd> navigate &nbsp; <kbd>n</kbd> next unreviewed &nbsp; <kbd>r</kbd> review &nbsp; <kbd>e</kbd> expand/collapse &nbsp; <kbd>?</kbd> help
      </div>
    </div>
  `;
}

function renderViewSwitcher() {
  const views = [
    ["editorial", "Editorial"],
    ["sidebar", "Sidebar"],
    ["focus", "Focus"],
    ["split", "Split"],
    ["developer", "Dev"],
    ["dashboard", "Dashboard"],
  ];
  return `<div class="toolbar-group view-switcher">${views.map(([id, label]) =>
    `<button class="btn btn-sm ${viewMode === id ? "active" : ""}" data-view="${id}">${label}</button>`
  ).join("")}</div>`;
}

function renderTOC(wt, coverage) {
  if (!wt.sections?.length) return "";
  let items = wt.sections
    .map((s) => {
      const reviewed = reviewState[s.id]?.reviewed;
      const readTime = getEstimatedReadTime(s);
      const commentCount = getCommentCountForSection(s);
      const meta = [];
      meta.push(`${readTime} min`);
      if (commentCount > 0) meta.push(`${commentCount} comment${commentCount > 1 ? "s" : ""}`);
      return `<li class="${reviewed ? "reviewed" : ""}"><a href="#section-${esc(s.id)}"><span class="toc-title">${esc(s.title)}</span>${reviewed ? ' <span class="check">✓</span>' : ""}<span class="toc-meta">${meta.join(" · ")}</span></a></li>`;
    })
    .join("");

  // Add "Remaining Changes" to TOC if there are uncovered files
  if (coverage && coverage.uncoveredCount > 0) {
    const reviewed = reviewState["__remaining"]?.reviewed;
    items += `<li class="${reviewed ? "reviewed" : ""}"><a href="#section-remaining">Remaining Changes (${coverage.uncoveredCount} files)${reviewed ? ' <span class="check">✓</span>' : ""}</a></li>`;
  }

  return `<nav class="toc"><ol>${items}</ol></nav>`;
}

function renderOverview(wt) {
  let content = `
    <section id="section-overview">
      <span class="section-number">Overview</span>
      <h2>The Big Picture</h2>
      <div class="narrative">${md(wt.overview)}</div>
  `;

  if (wt.architecture_diagram) {
    content += `
      <div class="diagram-container">
        <div class="diagram-label">Architecture</div>
        <div class="mermaid-source">${esc(wt.architecture_diagram)}</div>
      </div>
    `;
  }

  if (wt.review_tips?.length) {
    content += `
      <div class="callout insight">
        <span class="callout-label">Review Tips</span>
        <ul>${wt.review_tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      </div>
    `;
  }

  content += `</section>`;
  return content;
}

function renderSections(wt) {
  if (!wt.sections?.length) return "";
  return wt.sections.map((s, i) => renderSection(s, i)).join("");
}

function renderSection(section, index) {
  const reviewed = reviewState[section.id]?.reviewed;
  const collapsed = collapsedSections.has(section.id);
  // QW4: Count unique files in this section
  const fileCount = new Set(section.hunks?.map((h) => h.file) || []).size;

  let html = `
    <section id="section-${esc(section.id)}" class="review-section ${reviewed ? "reviewed" : ""} ${collapsed ? "collapsed" : ""}">
      <div class="section-header" data-section="${esc(section.id)}">
        <div class="section-header-left">
          <span class="section-number">Section ${String(index + 1).padStart(2, "0")}${fileCount > 0 ? ` · ${fileCount} file${fileCount !== 1 ? "s" : ""}` : ""}</span>
          <h2>${esc(section.title)}</h2>
        </div>
        <div class="section-header-right">
          <label class="review-checkbox" title="Mark as reviewed">
            <input type="checkbox" ${reviewed ? "checked" : ""} data-section-review="${esc(section.id)}" />
            <span class="review-checkbox-label">${reviewed ? "Reviewed ✓" : "Mark reviewed"}</span>
          </label>
          <button class="btn btn-icon collapse-toggle" data-collapse="${esc(section.id)}" title="${collapsed ? "Expand" : "Collapse"}">
            ${collapsed ? "▶" : "▼"}
          </button>
        </div>
      </div>
  `;

  if (!collapsed) {
    html += `<div class="section-body">`;
    html += `<div class="narrative">${md(section.narrative)}</div>`;

    if (section.diagram) {
      html += `
        <div class="diagram-container">
          <div class="diagram-label">Diagram</div>
          <div class="mermaid-source">${esc(section.diagram)}</div>
        </div>
      `;
    }

    // Render callouts
    if (section.callouts?.length) {
      for (const c of section.callouts) {
        html += `
          <div class="callout ${esc(c.type)}">
            <span class="callout-label">${esc(c.label)}</span>
            ${md(c.text)}
          </div>
        `;
      }
    }

    // Group hunks by file — show each file's diff once, with all annotations
    if (section.hunks?.length) {
      html += renderGroupedHunks(section.hunks, section.id);
    }

    html += `</div>`; // section-body
  }

  html += `</section>`;
  return html;
}

function renderFileBlocksWithExpand(displayFile, mode, filePath, hunkKey) {
  const blocks = displayFile.blocks;
  if (!blocks.length) return renderFileDiff(displayFile, mode);
  const canExpand = isGitHubPR();
  let html = "";

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    if (canExpand) {
      if (i === 0 && block.newStartLine > 1) {
        const count = Math.min(20, block.newStartLine - 1);
        html += `<div class="expand-context-bar" data-expand-file="${esc(filePath)}" data-expand-dir="up" data-expand-block="${block.newStartLine}" data-expand-hunk-key="${esc(hunkKey)}"><span class="expand-icon">⋮</span> Show ${count} line${count > 1 ? "s" : ""} above</div>`;
      } else if (i > 0) {
        const { lastNew: prevEnd } = getBlockEndLines(blocks[i - 1]);
        const gap = block.newStartLine - prevEnd - 1;
        if (gap > 0) {
          html += `<div class="expand-context-bar" data-expand-file="${esc(filePath)}" data-expand-dir="between" data-expand-block="${block.newStartLine}" data-expand-hunk-key="${esc(hunkKey)}"><span class="expand-icon">⋮</span> Show ${gap} hidden line${gap > 1 ? "s" : ""}</div>`;
        }
      }
    }

    const singleBlockFile = { ...displayFile, blocks: [block] };
    html += diff2htmlHtml([singleBlockFile], {
      drawFileList: false,
      matching: "lines",
      outputFormat: mode === "unified" ? "line-by-line" : "side-by-side",
    });
  }

  if (canExpand && blocks.length > 0) {
    html += `<div class="expand-context-bar" data-expand-file="${esc(filePath)}" data-expand-dir="down" data-expand-block="${blocks[blocks.length - 1].newStartLine}" data-expand-hunk-key="${esc(hunkKey)}"><span class="expand-icon">⋮</span> Show 20 lines below</div>`;
  }

  return html;
}

function renderGroupedHunks(hunks, sectionId) {
  // Group hunks by file path
  const fileGroups = new Map();
  for (const hunk of hunks) {
    const key = hunk.file;
    if (!fileGroups.has(key)) {
      fileGroups.set(key, []);
    }
    fileGroups.get(key).push(hunk);
  }

  let html = '<div class="hunks">';

  for (const [filePath, fileHunks] of fileGroups) {
    const file = findFile(filePath);
    const hunkKey = `${sectionId}:${filePath}`;
    const isCollapsed = collapsedHunks.has(hunkKey);

    // Determine the highest importance among hunks for this file
    const importanceOrder = { critical: 0, important: 1, supporting: 2, context: 3 };
    const topImportance = fileHunks.reduce((best, h) => {
      const hImp = h.importance || "important";
      return (importanceOrder[hImp] || 2) < (importanceOrder[best] || 2) ? hImp : best;
    }, fileHunks[0].importance || "important");

    // Line range summary
    const lineRanges = fileHunks
      .filter((h) => h.startLine)
      .map((h) => h.startLine === h.endLine ? `L${h.startLine}` : `L${h.startLine}–${h.endLine}`)
      .join(", ");

    html += `
      <div class="hunk-group importance-${topImportance}">
        <div class="hunk-header" data-hunk-toggle="${esc(hunkKey)}">
          <span class="hunk-file">${esc(filePath)}</span>
          <span class="hunk-lines">${lineRanges}</span>
          <span class="hunk-count">${fileHunks.length} annotation${fileHunks.length > 1 ? "s" : ""}</span>
          <span class="hunk-importance importance-badge-${topImportance}">${topImportance}</span>
          <span class="hunk-toggle-icon">${isCollapsed ? "▶" : "▼"}</span>
        </div>
    `;

    if (!isCollapsed) {
      // Show all annotations for this file
      for (const hunk of fileHunks) {
        if (hunk.annotation) {
          const imp = hunk.importance || "important";
          html += `
            <div class="hunk-annotation annotation-${imp}">
              <span class="annotation-lines">${hunk.startLine ? (hunk.startLine === hunk.endLine ? `L${hunk.startLine}` : `L${hunk.startLine}–${hunk.endLine}`) : ""}</span>
              ${md(hunk.annotation)}
            </div>
          `;
        }
      }

      // Show the file diff — filtered to referenced line ranges unless user toggled full view
      if (file) {
        const isFull = showFullFile.has(hunkKey);
        const filteredFile = filterFileToRanges(file, fileHunks);
        const canFilter = filteredFile.blocks.length < file.blocks.length;
        const displayFile = isFull ? file : filteredFile;

        html += `<div class="hunk-diff" data-hunk-file="${esc(filePath)}" data-hunk-key="${esc(hunkKey)}">`;
        if (canFilter && !isFull) {
          html += `<div class="diff-filter-notice">Showing ${filteredFile.blocks.length} of ${file.blocks.length} hunks matching referenced lines · <button class="btn-link" data-show-full="${esc(hunkKey)}">Show all ${file.blocks.length} hunks</button></div>`;
        } else if (canFilter && isFull) {
          html += `<div class="diff-filter-notice">Showing all ${file.blocks.length} hunks · <button class="btn-link" data-show-full="${esc(hunkKey)}">Show only referenced hunks</button></div>`;
        }
        html += renderFileBlocksWithExpand(displayFile, diffViewMode, filePath, hunkKey);
        html += `</div>`;
      } else {
        html += `<div class="hunk-diff no-diff">File "${esc(filePath)}" not found in diff</div>`;
      }

      // Show existing comments for this file
      if (showComments) {
        html += renderFileComments(filePath);
      }

      // Comment composer (only for GitHub PRs)
      if (isGitHubPR()) {
        html += `
          <div class="comment-composer" data-file="${esc(filePath)}">
            <textarea class="comment-textarea" placeholder="Leave a review comment on ${esc(filePath.split('/').pop())}..." rows="2" data-comment-file="${esc(filePath)}"></textarea>
            <div class="comment-actions">
              <input type="number" class="comment-line-input" placeholder="Line #" min="1" data-comment-line-for="${esc(filePath)}" />
              <button class="btn btn-sm" data-post-comment="${esc(filePath)}">Comment</button>
            </div>
          </div>
        `;
      }
    }

    html += `</div>`;
  }

  html += "</div>";
  return html;
}

function renderFileComments(filePath) {
  const threads = getCommentThreads(filePath);
  if (!threads.length) return "";

  let html = '<div class="file-comments">';

  for (const thread of threads) {
    html += `
      <div class="comment-thread">
        <div class="comment">
          <div class="comment-meta">
            <span class="comment-author">${esc(thread.user)}</span>
            ${thread.line ? `<span class="comment-line">Line ${thread.line}</span>` : ""}
            <span class="comment-time">${timeAgo(thread.createdAt)}</span>
          </div>
          <div class="comment-body">${md(thread.body)}</div>
        </div>
    `;

    for (const reply of thread.replies) {
      html += `
        <div class="comment comment-reply">
          <div class="comment-meta">
            <span class="comment-author">${esc(reply.user)}</span>
            <span class="comment-time">${timeAgo(reply.createdAt)}</span>
          </div>
          <div class="comment-body">${md(reply.body)}</div>
        </div>
      `;
    }

    html += `</div>`;
  }

  html += "</div>";
  return html;
}

function renderReviewsSummary() {
  if (!data?.reviews?.length) return "";

  const reviews = data.reviews.filter((r) => r.state !== "PENDING" && r.state !== "DISMISSED");
  if (!reviews.length) return "";

  const html = reviews.map((r) => {
    const stateClass = r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes-requested" : "commented";
    const stateLabel = r.state === "APPROVED" ? "Approved" : r.state === "CHANGES_REQUESTED" ? "Changes requested" : "Commented";
    return `
      <div class="review-item review-${stateClass}">
        <span class="review-author">${esc(r.user)}</span>
        <span class="review-state">${stateLabel}</span>
        <span class="review-time">${timeAgo(r.submittedAt)}</span>
        ${r.body ? `<div class="review-body">${md(r.body)}</div>` : ""}
      </div>
    `;
  }).join("");

  return `<div class="reviews-summary">${html}</div>`;
}

function renderReviewModal() {
  return `
    <div class="review-modal" id="review-modal" style="display:none;">
      <div class="review-modal-backdrop" data-close-modal></div>
      <div class="review-modal-content">
        <h3 id="review-modal-title">Submit Review</h3>
        <textarea id="review-modal-body" rows="4" placeholder="Leave a comment (optional for approve)..."></textarea>
        <div class="review-modal-actions">
          <button class="btn" data-close-modal>Cancel</button>
          <button class="btn" id="review-modal-submit">Submit</button>
        </div>
      </div>
    </div>
  `;
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

// ─── Remaining Changes (files not in walkthrough) ────
function renderRemainingChanges(coverage) {
  if (!coverage || coverage.uncoveredCount === 0) return "";

  const reviewed = reviewState["__remaining"]?.reviewed;
  const collapsed = collapsedSections.has("__remaining");

  // QW6: Sort uncovered files by size (lines changed) descending
  const sortedUncovered = [...coverage.uncovered].sort((a, b) => {
    const statsA = parsedFiles[a] ? getFileStats(parsedFiles[a]) : { additions: 0, deletions: 0 };
    const statsB = parsedFiles[b] ? getFileStats(parsedFiles[b]) : { additions: 0, deletions: 0 };
    return (statsB.additions + statsB.deletions) - (statsA.additions + statsA.deletions);
  });

  // Group uncovered files by directory to reduce overwhelm
  const groups = groupFilesByDirectory(sortedUncovered);

  let html = `
    <section id="section-remaining" class="review-section remaining-section ${reviewed ? "reviewed" : ""} ${collapsed ? "collapsed" : ""}">
      <div class="section-header" data-section="__remaining">
        <div class="section-header-left">
          <span class="section-number">Remaining Changes</span>
          <h2>${coverage.uncoveredCount} files not in walkthrough</h2>
        </div>
        <div class="section-header-right">
          <label class="review-checkbox" title="Mark as reviewed">
            <input type="checkbox" ${reviewed ? "checked" : ""} data-section-review="__remaining" />
            <span class="review-checkbox-label">${reviewed ? "Reviewed ✓" : "Mark reviewed"}</span>
          </label>
          <button class="btn btn-icon collapse-toggle" data-collapse="__remaining" title="${collapsed ? "Expand" : "Collapse"}">
            ${collapsed ? "▶" : "▼"}
          </button>
        </div>
      </div>
  `;

  if (!collapsed) {
    html += `<div class="section-body">`;
    html += `<div class="narrative"><p>These files were changed in the PR but not featured in the AI walkthrough above. They may be mechanical changes (imports, re-exports, signature updates) or less critical modifications.</p></div>`;

    for (const [dir, files] of groups) {
      const groupKey = `__remaining:${dir}`;
      const groupCollapsed = collapsedHunks.has(groupKey);
      const fileCount = files.length;

      html += `
        <div class="remaining-group">
          <div class="remaining-group-header" data-hunk-toggle="${esc(groupKey)}">
            <span class="hunk-file">${esc(dir || "(root)")}/</span>
            <span class="hunk-count">${fileCount} file${fileCount > 1 ? "s" : ""}</span>
            <span class="hunk-toggle-icon">${groupCollapsed ? "▶" : "▼"}</span>
          </div>
      `;

      if (!groupCollapsed) {
        for (const filePath of files) {
          const file = parsedFiles[filePath];
          const fileKey = `__remaining:file:${filePath}`;
          // Remaining files start collapsed by default (inverted logic: set = expanded)
          const fileCollapsed = !collapsedHunks.has(fileKey);
          const fileReviewed = reviewState[`file:${filePath}`]?.reviewed;
          const fileComments = getCommentThreads(filePath);
          const fileName = filePath.split("/").pop();

          // Compute stats for this file
          const stats = file ? getFileStats(file) : null;

          html += `
            <div class="remaining-file ${fileReviewed ? "file-reviewed" : ""}">
              <div class="remaining-file-header" data-hunk-toggle="${esc(fileKey)}">
                <label class="file-review-checkbox" onclick="event.stopPropagation()">
                  <input type="checkbox" ${fileReviewed ? "checked" : ""} data-file-review="${esc(filePath)}" />
                </label>
                <span class="remaining-file-name">${esc(fileName)}</span>
                ${stats ? `<span class="remaining-file-stats">+${stats.additions} −${stats.deletions}</span>` : ""}
                ${fileComments.length ? `<span class="remaining-file-comments">${fileComments.length} comment${fileComments.length > 1 ? "s" : ""}</span>` : ""}
                <span class="hunk-toggle-icon">${fileCollapsed ? "▶" : "▼"}</span>
              </div>
          `;

          if (!fileCollapsed) {
            if (file) {
              html += `<div class="hunk-diff">${renderFileDiff(file, diffViewMode)}</div>`;
            }
            if (showComments && fileComments.length) {
              html += renderFileComments(filePath);
            }
            if (isGitHubPR()) {
              html += `
                <div class="comment-composer" data-file="${esc(filePath)}">
                  <textarea class="comment-textarea" placeholder="Comment on ${esc(fileName)}..." rows="2" data-comment-file="${esc(filePath)}"></textarea>
                  <div class="comment-actions">
                    <input type="number" class="comment-line-input" placeholder="Line #" min="1" data-comment-line-for="${esc(filePath)}" />
                    <button class="btn btn-sm" data-post-comment="${esc(filePath)}">Comment</button>
                  </div>
                </div>
              `;
            }
          }

          html += `</div>`;
        }
      }

      html += `</div>`;
    }

    html += `</div>`; // section-body
  }

  html += `</section>`;
  return html;
}

function groupFilesByDirectory(filePaths) {
  const groups = new Map();
  for (const path of filePaths) {
    const parts = path.split("/");
    // Use first 2-3 directory levels as the group key
    const dir = parts.length > 1 ? parts.slice(0, Math.min(parts.length - 1, 3)).join("/") : "";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(path);
  }
  // Sort groups by path
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function getFileStats(file) {
  let additions = 0;
  let deletions = 0;
  for (const block of file.blocks || []) {
    for (const line of block.lines || []) {
      if (line.type === "insert") additions++;
      if (line.type === "delete") deletions++;
    }
  }
  return { additions, deletions };
}

function renderOrphanedComments(coverage) {
  // Show comments on files that aren't even in the diff (rare but possible)
  if (!data?.comments?.length) return "";

  const allDiffFiles = new Set(Object.keys(parsedFiles));
  const allWalkthroughFiles = new Set();
  if (data.walkthrough?.sections) {
    for (const s of data.walkthrough.sections) {
      for (const h of s.hunks || []) {
        allWalkthroughFiles.add(h.file);
      }
    }
  }

  // Find comments on files not in the walkthrough AND not in uncovered files
  const orphaned = data.comments.filter((c) => {
    const inDiff = [...allDiffFiles].some((f) => f === c.path || f.endsWith(c.path) || c.path.endsWith(f));
    const inWalkthrough = [...allWalkthroughFiles].some((f) => f === c.path || f.endsWith(c.path) || c.path.endsWith(f));
    const inUncovered = (coverage?.uncovered || []).some((f) => f === c.path || f.endsWith(c.path) || c.path.endsWith(f));
    return !inWalkthrough && !inUncovered;
  });

  if (!orphaned.length) return "";

  // Group by file
  const byFile = new Map();
  for (const c of orphaned) {
    if (!byFile.has(c.path)) byFile.set(c.path, []);
    byFile.get(c.path).push(c);
  }

  let html = `
    <section id="section-orphaned-comments" class="review-section">
      <span class="section-number">Review Comments</span>
      <h2>Comments on Other Files</h2>
      <div class="section-body">
        <div class="narrative"><p>These review comments reference files not directly shown in the diff above.</p></div>
  `;

  for (const [filePath, comments] of byFile) {
    html += `<div class="hunk-group importance-important">`;
    html += `<div class="hunk-header"><span class="hunk-file">${esc(filePath)}</span><span class="hunk-count">${comments.length} comment${comments.length > 1 ? "s" : ""}</span></div>`;
    html += renderFileComments(filePath);
    html += `</div>`;
  }

  html += `</div></section>`;
  return html;
}

function renderFileMap(wt) {
  if (!wt.file_map?.length) return "";

  const items = wt.file_map
    .map((f) => {
      const cls = f.is_new ? "new-file" : "file";
      return `<div class="indent ${cls}">${esc(f.path)} — ${esc(f.description)}</div>`;
    })
    .join("");

  return `
    <section id="section-file-map">
      <span class="section-number">Appendix</span>
      <h2>File Map</h2>
      <div class="file-tree">${items}</div>
    </section>
  `;
}

// QW5: Review complete prompt when all sections are checked
function renderReviewCompleteBanner(progress) {
  if (progress.pct !== 100 || progress.total === 0) return "";
  const gh = isGitHubPR();

  return `
    <div class="review-complete-banner">
      <div class="review-complete-icon">✓</div>
      <div class="review-complete-text">
        <strong>Review complete</strong> — All ${progress.total} sections reviewed.
        ${gh ? "Ready to submit your review?" : ""}
      </div>
      ${gh ? `
        <div class="review-complete-actions">
          <button class="btn btn-sm btn-approve" id="btn-complete-approve">Approve</button>
          <button class="btn btn-sm btn-request-changes" id="btn-complete-request-changes">Request Changes</button>
        </div>
      ` : ""}
    </div>
  `;
}

function renderFooter(meta) {
  return `
    <footer class="page-footer">
      <p>Generated ${meta.generatedAt ? new Date(meta.generatedAt).toLocaleString() : "just now"}</p>
      ${meta.url ? `<p><a href="${esc(meta.url)}" target="_blank">View on GitHub ↗</a></p>` : ""}
    </footer>
  `;
}

function renderMinimap(wt) {
  if (!wt.sections?.length) return "";

  const items = wt.sections
    .map((s) => {
      const reviewed = reviewState[s.id]?.reviewed;
      return `<a href="#section-${esc(s.id)}" class="minimap-item ${reviewed ? "reviewed" : ""}" title="${esc(s.title)}"></a>`;
    })
    .join("");

  return `<div class="minimap">${items}</div>`;
}

// ─── Handlers ────────────────────────────────────────
function setupHandlers() {
  // View mode switcher
  document.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      viewMode = btn.dataset.view;
      localStorage.setItem("review-tool-view", viewMode);
      render();
    });
  });

  // Dark mode toggle
  document.getElementById("btn-dark-mode")?.addEventListener("click", () => {
    darkMode = !darkMode;
    localStorage.setItem("review-tool-dark", String(darkMode));
    render();
  });

  // Focus mode navigation
  if (viewMode === "focus") {
    document.getElementById("btn-prev-section")?.addEventListener("click", () => {
      currentSectionIndex = Math.max(0, currentSectionIndex - 1);
      render();
    });
    document.getElementById("btn-next-section")?.addEventListener("click", () => {
      currentSectionIndex++;
      render();
    });
    document.querySelectorAll("[data-focus-step]").forEach((el) => {
      el.addEventListener("click", () => {
        currentSectionIndex = parseInt(el.dataset.focusStep);
        render();
      });
    });
  }

  // Dashboard card click → switch to focus on that section
  if (viewMode === "dashboard") {
    document.querySelectorAll("[data-dashboard-section]").forEach((card) => {
      card.addEventListener("click", () => {
        currentSectionIndex = parseInt(card.dataset.dashboardSection) + 1; // +1 for overview
        viewMode = "focus";
        localStorage.setItem("review-tool-view", viewMode);
        render();
      });
    });
  }

  // Diff view mode toggle
  document.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      diffViewMode = btn.dataset.mode;
      render();
    });
  });

  // Review checkboxes
  document.querySelectorAll("[data-section-review]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.sectionReview;
      reviewState[id] = {
        reviewed: cb.checked,
        timestamp: new Date().toISOString(),
      };
      saveReviewState();
      render();
    });
  });

  // Collapse toggles for sections
  document.querySelectorAll("[data-collapse]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.collapse;
      if (collapsedSections.has(id)) {
        collapsedSections.delete(id);
      } else {
        collapsedSections.add(id);
      }
      saveReviewState();
      render();
    });
  });

  // Collapse toggles for file hunks
  document.querySelectorAll("[data-hunk-toggle]").forEach((hdr) => {
    hdr.addEventListener("click", () => {
      const key = hdr.dataset.hunkToggle;
      if (collapsedHunks.has(key)) {
        collapsedHunks.delete(key);
      } else {
        collapsedHunks.add(key);
      }
      saveReviewState();
      render();
    });
  });

  // Toggle full/filtered file diff view
  document.querySelectorAll("[data-show-full]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = btn.dataset.showFull;
      if (showFullFile.has(key)) {
        showFullFile.delete(key);
      } else {
        showFullFile.add(key);
      }
      render();
    });
  });

  // Section header click to collapse
  document.querySelectorAll(".section-header").forEach((hdr) => {
    hdr.addEventListener("click", (e) => {
      if (e.target.closest(".review-checkbox") || e.target.closest(".collapse-toggle")) return;
      const id = hdr.dataset.section;
      if (collapsedSections.has(id)) {
        collapsedSections.delete(id);
      } else {
        collapsedSections.add(id);
      }
      saveReviewState();
      render();
    });
  });

  // Expand/Collapse all
  document.getElementById("btn-expand-all")?.addEventListener("click", () => {
    collapsedSections.clear();
    collapsedHunks.clear();
    saveReviewState();
    render();
  });

  document.getElementById("btn-collapse-all")?.addEventListener("click", () => {
    data.walkthrough.sections.forEach((s) => collapsedSections.add(s.id));
    saveReviewState();
    render();
  });

  // Reset review
  document.getElementById("btn-reset-review")?.addEventListener("click", () => {
    if (confirm("Reset all review progress?")) {
      reviewState = {};
      saveReviewState();
      render();
    }
  });

  // Keyboard shortcuts — use a single registered listener to prevent duplicates
  if (!window.__reviewToolKeyboardBound) {
    document.addEventListener("keydown", handleKeyboard);
    window.__reviewToolKeyboardBound = true;
  }

  // Smooth scroll for TOC links
  document.querySelectorAll(".toc a, .minimap-item").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.querySelector(a.getAttribute("href"));
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  // Toggle comments visibility
  document.getElementById("btn-toggle-comments")?.addEventListener("click", () => {
    showComments = !showComments;
    render();
  });

  // Refresh comments from GitHub
  document.getElementById("btn-refresh-comments")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-refresh-comments");
    if (btn) btn.textContent = "Refreshing...";
    await refreshComments();
  });

  // File-level review checkboxes (for remaining changes)
  document.querySelectorAll("[data-file-review]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const filePath = cb.dataset.fileReview;
      reviewState[`file:${filePath}`] = {
        reviewed: cb.checked,
        timestamp: new Date().toISOString(),
      };
      saveReviewState();
      render();
    });
  });

  // Post comment buttons
  document.querySelectorAll("[data-post-comment]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const filePath = btn.dataset.postComment;
      const textarea = document.querySelector(`[data-comment-file="${filePath}"]`);
      const lineInput = document.querySelector(`[data-comment-line-for="${filePath}"]`);
      const body = textarea?.value?.trim();
      const line = lineInput?.value ? parseInt(lineInput.value) : null;

      if (!body) return;

      btn.textContent = "Posting...";
      btn.disabled = true;

      try {
        await postComment(filePath, line || 1, "RIGHT", body);
        textarea.value = "";
        if (lineInput) lineInput.value = "";
        render();
      } catch (err) {
        alert("Failed to post comment: " + err.message);
        btn.textContent = "Comment";
        btn.disabled = false;
      }
    });
  });

  // Approve button
  document.getElementById("btn-approve")?.addEventListener("click", () => {
    openReviewModal("APPROVE", "Approve this PR");
  });

  // Request changes button
  document.getElementById("btn-request-changes")?.addEventListener("click", () => {
    openReviewModal("REQUEST_CHANGES", "Request Changes");
  });

  // QW5: Review complete banner buttons
  document.getElementById("btn-complete-approve")?.addEventListener("click", () => {
    openReviewModal("APPROVE", "Approve this PR");
  });
  document.getElementById("btn-complete-request-changes")?.addEventListener("click", () => {
    openReviewModal("REQUEST_CHANGES", "Request Changes");
  });

  // Review modal handlers
  document.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", () => {
      document.getElementById("review-modal").style.display = "none";
    });
  });

  document.getElementById("review-modal-submit")?.addEventListener("click", async () => {
    const modal = document.getElementById("review-modal");
    const body = document.getElementById("review-modal-body")?.value?.trim();
    const event = modal.dataset.event;

    if (event === "REQUEST_CHANGES" && !body) {
      alert("Please provide a reason for requesting changes.");
      return;
    }

    const submitBtn = document.getElementById("review-modal-submit");
    if (submitBtn) {
      submitBtn.textContent = "Submitting...";
      submitBtn.disabled = true;
    }

    try {
      await submitReview(event, body);
      modal.style.display = "none";
      render();
    } catch (err) {
      alert("Failed to submit review: " + err.message);
      if (submitBtn) {
        submitBtn.textContent = "Submit";
        submitBtn.disabled = false;
      }
    }
  });

  // Expand context buttons
  document.querySelectorAll("[data-expand-file]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const filePath = btn.dataset.expandFile;
      const dir = btn.dataset.expandDir;
      const blockStart = parseInt(btn.dataset.expandBlock);
      const hunkKey = btn.dataset.expandHunkKey;
      btn.textContent = "Loading...";
      btn.classList.add("loading");
      if (hunkKey) showFullFile.add(hunkKey);
      await expandContext(filePath, dir, blockStart);
    });
  });

  // Jump to definition (Ctrl+Click on code in diff)
  if (!window.__jumpToDefBound) {
    document.addEventListener("click", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const codeLine = e.target.closest(".d2h-code-line-ctn, .d2h-code-side-line");
      if (!codeLine) return;
      const word = getWordAtPoint(e);
      if (!word || word.length < 2) return;
      e.preventDefault();
      const defs = findDefinitionsInDiff(word);
      if (defs.length > 0) {
        showJumpPopup(defs, e.pageX, e.pageY);
      }
    });
    window.__jumpToDefBound = true;
  }
}

function openReviewModal(event, title) {
  const modal = document.getElementById("review-modal");
  if (!modal) return;
  modal.dataset.event = event;
  document.getElementById("review-modal-title").textContent = title;
  document.getElementById("review-modal-body").value = "";
  const submitBtn = document.getElementById("review-modal-submit");
  submitBtn.textContent = title;
  submitBtn.disabled = false;
  submitBtn.className = event === "APPROVE" ? "btn btn-approve" : "btn btn-request-changes";
  modal.style.display = "flex";
}

function setupLandingHandlers() {
  // Fetch PR
  document.getElementById("btn-fetch-pr")?.addEventListener("click", async () => {
    const url = document.getElementById("pr-url")?.value?.trim();
    if (!url) return;
    await generateFromURL(url);
  });

  // Enter key on input
  document.getElementById("pr-url")?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const url = e.target.value.trim();
      if (url) await generateFromURL(url);
    }
  });

  // Load file
  document.getElementById("btn-load-file")?.addEventListener("click", () => {
    const input = document.getElementById("file-input");
    const file = input?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        data = JSON.parse(e.target.result);
        parsedFiles = parseDiff(data.diff);
        loadReviewState();
        applyAutoCollapse();
        render();
      } catch (err) {
        alert("Failed to parse JSON: " + err.message);
      }
    };
    reader.readAsText(file);
  });

  // Demo
  document.getElementById("btn-demo")?.addEventListener("click", async () => {
    try {
      const resp = await fetch("/walkthrough-data.json");
      if (resp.ok) {
        data = await resp.json();
        parsedFiles = parseDiff(data.diff);
        loadReviewState();
        applyAutoCollapse();
        render();
      } else {
        alert(
          "No demo data found. Generate one first with:\n  node src/generate.js https://github.com/owner/repo/pull/123"
        );
      }
    } catch {
      alert("No demo data found.");
    }
  });
}

async function generateFromURL(url) {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="page-container">
      <div class="loading">
        <div class="loading-spinner"></div>
        <h2>Generate via CLI</h2>
        <p>Run this in your terminal, then reload:</p>
        <pre><code>node src/generate.js ${esc(url)}</code></pre>
        <button class="btn btn-primary" onclick="location.reload()">Reload</button>
      </div>
    </div>
  `;
}

function handleKeyboard(e) {
  if (!data) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

  // j/k to navigate sections
  if (e.key === "j" || e.key === "k") {
    const sections = Array.from(document.querySelectorAll(".review-section"));
    if (!sections.length) return;

    const scrollY = window.scrollY + 100;
    let current = 0;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].offsetTop <= scrollY) current = i;
    }

    const next = e.key === "j" ? Math.min(current + 1, sections.length - 1) : Math.max(current - 1, 0);
    sections[next].scrollIntoView({ behavior: "smooth", block: "start" });
    e.preventDefault();
  }

  // r to toggle review on current section
  if (e.key === "r") {
    const sections = Array.from(document.querySelectorAll(".review-section"));
    const scrollY = window.scrollY + 100;
    let current = 0;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].offsetTop <= scrollY) current = i;
    }
    const sectionEl = sections[current];
    if (sectionEl) {
      const cb = sectionEl.querySelector("[data-section-review]");
      if (cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      }
    }
    e.preventDefault();
  }

  // e to expand/collapse current section
  if (e.key === "e") {
    const sections = Array.from(document.querySelectorAll(".review-section"));
    const scrollY = window.scrollY + 100;
    let current = 0;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].offsetTop <= scrollY) current = i;
    }
    const sectionEl = sections[current];
    if (sectionEl) {
      const btn = sectionEl.querySelector("[data-collapse]");
      if (btn) btn.click();
    }
    e.preventDefault();
  }

  // QW3: n to jump to next unreviewed section
  if (e.key === "n") {
    const allSections = data.walkthrough?.sections || [];
    const coverage = getFileCoverage(data.walkthrough);
    const sectionIds = allSections.map((s) => s.id);
    if (coverage.uncoveredCount > 0) sectionIds.push("__remaining");

    const firstUnreviewed = sectionIds.find((id) => !reviewState[id]?.reviewed);
    if (firstUnreviewed) {
      const targetId = firstUnreviewed === "__remaining" ? "section-remaining" : `section-${firstUnreviewed}`;
      const target = document.getElementById(targetId);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
    e.preventDefault();
  }

  // QW9: ? to show keyboard shortcuts
  if (e.key === "?") {
    toggleShortcutsModal();
    e.preventDefault();
  }
}

// QW9: Shortcuts modal
function toggleShortcutsModal() {
  let modal = document.getElementById("shortcuts-modal");
  if (modal) {
    modal.remove();
    return;
  }

  modal = document.createElement("div");
  modal.id = "shortcuts-modal";
  modal.className = "shortcuts-modal";
  modal.innerHTML = `
    <div class="shortcuts-modal-backdrop" data-close-shortcuts></div>
    <div class="shortcuts-modal-content">
      <h3>Keyboard Shortcuts</h3>
      <div class="shortcuts-list">
        <div class="shortcut-row"><kbd>j</kbd> / <kbd>k</kbd><span>Next / previous section</span></div>
        <div class="shortcut-row"><kbd>n</kbd><span>Jump to next unreviewed section</span></div>
        <div class="shortcut-row"><kbd>r</kbd><span>Toggle review on current section</span></div>
        <div class="shortcut-row"><kbd>e</kbd><span>Expand / collapse current section</span></div>
        <div class="shortcut-row"><kbd>?</kbd><span>Show this help</span></div>
      </div>
      <button class="btn btn-sm" data-close-shortcuts>Close</button>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelectorAll("[data-close-shortcuts]").forEach((el) => {
    el.addEventListener("click", () => modal.remove());
  });
}

// ─── Utility ─────────────────────────────────────────
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Init ────────────────────────────────────────────
async function init() {
  // Try to auto-load walkthrough data
  try {
    const resp = await fetch("/walkthrough-data.json");
    if (resp.ok) {
      data = await resp.json();
      parsedFiles = parseDiff(data.diff);
      loadReviewState();
      applyAutoCollapse(); // QW2: auto-collapse supporting/context hunks
    }
  } catch {
    // No data, show landing
  }

  render();
  if (data) loadMermaid();
}

init();
