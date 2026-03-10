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

function loadReviewState() {
  try {
    const key = `review-${data?.meta?.url || data?.meta?.title || "local"}`;
    const saved = localStorage.getItem(key);
    if (saved) reviewState = JSON.parse(saved);
  } catch {
    /* ignore */
  }
}

function saveReviewState() {
  try {
    const key = `review-${data?.meta?.url || data?.meta?.title || "local"}`;
    localStorage.setItem(key, JSON.stringify(reviewState));
  } catch {
    /* ignore */
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
      const { svg } = await window.mermaid.render(id, el.textContent.trim());
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

// ─── Progress ────────────────────────────────────────
function getProgress() {
  if (!data?.walkthrough?.sections) return { reviewed: 0, total: 0, pct: 0 };
  const total = data.walkthrough.sections.length;
  const reviewed = data.walkthrough.sections.filter(
    (s) => reviewState[s.id]?.reviewed
  ).length;
  return { reviewed, total, pct: total ? Math.round((reviewed / total) * 100) : 0 };
}

// ─── Rendering ───────────────────────────────────────
function render() {
  const app = document.getElementById("app");
  const scrollY = window.scrollY;

  if (!data) {
    app.innerHTML = renderLanding();
    setupLandingHandlers();
    return;
  }

  const { walkthrough: wt, meta } = data;
  const progress = getProgress();

  app.innerHTML = `
    <div class="page-container">
      ${renderHeader(wt, meta, progress)}
      ${renderProgressBar(progress)}
      ${renderToolbar()}
      ${renderTOC(wt)}
      ${renderOverview(wt)}
      ${renderSections(wt)}
      ${renderFileMap(wt)}
      ${renderFooter(meta)}
    </div>
    ${renderMinimap(wt)}
  `;

  setupHandlers();
  renderMermaid(app);

  // Restore scroll position
  requestAnimationFrame(() => window.scrollTo(0, scrollY));
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
  return `
    <header class="page-header">
      <div class="kicker">Code Review Walkthrough</div>
      <h1>${esc(wt.title)}</h1>
      <p class="subtitle">${esc(wt.subtitle)}</p>
      <div class="meta">
        ${meta.url ? `<span class="meta-item"><a href="${esc(meta.url)}" target="_blank">PR Link ↗</a></span>` : ""}
        <span class="meta-item">${esc(meta.headBranch)} → ${esc(meta.baseBranch)}</span>
        <span class="meta-item">+${meta.additions} −${meta.deletions}</span>
        <span class="meta-item">${meta.changedFiles} files</span>
        <span class="meta-item review-status ${progress.pct === 100 ? "complete" : ""}">${progress.reviewed}/${progress.total} sections reviewed</span>
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

function renderToolbar() {
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
        <button class="btn btn-sm" id="btn-reset-review">Reset Review</button>
      </div>
      <div class="toolbar-hint">
        <kbd>j</kbd>/<kbd>k</kbd> navigate &nbsp; <kbd>r</kbd> review &nbsp; <kbd>e</kbd> expand/collapse
      </div>
    </div>
  `;
}

function renderTOC(wt) {
  if (!wt.sections?.length) return "";
  const items = wt.sections
    .map((s) => {
      const reviewed = reviewState[s.id]?.reviewed;
      return `<li class="${reviewed ? "reviewed" : ""}"><a href="#section-${esc(s.id)}">${esc(s.title)}${reviewed ? ' <span class="check">✓</span>' : ""}</a></li>`;
    })
    .join("");
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

  let html = `
    <section id="section-${esc(section.id)}" class="review-section ${reviewed ? "reviewed" : ""} ${collapsed ? "collapsed" : ""}">
      <div class="section-header" data-section="${esc(section.id)}">
        <div class="section-header-left">
          <span class="section-number">Section ${String(index + 1).padStart(2, "0")}</span>
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

      // Show the file diff once
      if (file) {
        html += `<div class="hunk-diff">${renderFileDiff(file, diffViewMode)}</div>`;
      } else {
        html += `<div class="hunk-diff no-diff">File "${esc(filePath)}" not found in diff</div>`;
      }
    }

    html += `</div>`;
  }

  html += "</div>";
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
      render();
    });
  });

  // Expand/Collapse all
  document.getElementById("btn-expand-all")?.addEventListener("click", () => {
    collapsedSections.clear();
    collapsedHunks.clear();
    render();
  });

  document.getElementById("btn-collapse-all")?.addEventListener("click", () => {
    data.walkthrough.sections.forEach((s) => collapsedSections.add(s.id));
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
    }
  } catch {
    // No data, show landing
  }

  render();
  if (data) loadMermaid();
}

init();
