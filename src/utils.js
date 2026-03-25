export function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTable(block) {
  const rows = block.trim().split("\n").filter(r => r.trim());
  if (rows.length < 2) return block;
  const parseRow = (r) => r.split("|").map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length);
  const headers = parseRow(rows[0]);
  // Skip separator row (row[1])
  const bodyRows = rows.slice(2);
  let html = '<table class="chat-table"><thead><tr>';
  for (const h of headers) html += `<th>${h}</th>`;
  html += "</tr></thead><tbody>";
  for (const row of bodyRows) {
    html += "<tr>";
    for (const cell of parseRow(row)) html += `<td>${cell}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

export function md(text) {
  if (!text) return "";
  const codeBlocks = [];
  const tables = [];
  let result = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Protect code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const i = codeBlocks.length;
      codeBlocks.push(`<pre><code${lang ? ` class="language-${lang}"` : ""}>${code.trim()}</code></pre>`);
      return `\x00CB${i}\x00`;
    })
    // Protect tables (lines starting with |)
    .replace(/(^\|.+\|$\n?){2,}/gm, (match) => {
      const i = tables.length;
      tables.push(renderTable(match));
      return `\x00TB${i}\x00`;
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
    .replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[i])
    .replace(/\x00TB(\d+)\x00/g, (_, i) => tables[i]);
  return result;
}

export function timeAgo(dateStr) {
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

export function groupFilesByDirectory(filePaths) {
  const groups = new Map();
  for (const path of filePaths) {
    const parts = path.split("/");
    const dir = parts.length > 1 ? parts.slice(0, Math.min(parts.length - 1, 3)).join("/") : "";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(path);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Post-process HTML to turn file:line references into clickable scroll links.
 * Matches patterns like `src/foo.js:42`, `config.ts:15-20`, `foo.py:100`.
 * Only matches inside text nodes (not already inside tags).
 */
export function linkFileRefs(html) {
  if (!html) return html;
  // Match file:line references — file must have an extension, line is a number with optional range
  // Negative lookbehind for < ensures we don't match inside HTML tags
  return html.replace(
    /(?:<code>)?([\w./-]+\.\w{1,10}):(\d+)(?:-(\d+))?(?:<\/code>)?/g,
    (match, file, startLine, endLine) => {
      const display = endLine ? `${file}:${startLine}-${endLine}` : `${file}:${startLine}`;
      return `<a class="file-ref-link" data-file-ref="${file}" data-line="${startLine}" data-end-line="${endLine || startLine}" title="Jump to ${display}">${display}</a>`;
    }
  );
}

/**
 * Find and scroll to a file:line reference in the diff view.
 * Looks for hunk groups with matching file paths, then scrolls to the right line.
 */
export function scrollToFileLine(filePath, lineNumber) {
  // Find all hunk elements matching this file
  const hunks = document.querySelectorAll(`[data-hunk-file]`);
  let target = null;

  for (const hunk of hunks) {
    const hunkFile = hunk.getAttribute("data-hunk-file");
    if (hunkFile === filePath || hunkFile.endsWith("/" + filePath) || filePath.endsWith("/" + hunkFile)) {
      target = hunk;
      break;
    }
  }

  if (!target) {
    // Try partial match on just the filename
    const basename = filePath.split("/").pop();
    for (const hunk of hunks) {
      if (hunk.getAttribute("data-hunk-file").endsWith("/" + basename)) {
        target = hunk;
        break;
      }
    }
  }

  if (!target) return;

  // Expand if collapsed
  const hunkKey = target.getAttribute("data-hunk-key");
  const parentGroup = target.closest(".hunk-group");
  if (parentGroup) {
    const toggle = parentGroup.querySelector("[data-hunk-toggle]");
    if (toggle && parentGroup.querySelector(".hunk-diff") === null) {
      toggle.click(); // Expand collapsed hunk
    }
  }

  // Try to find the exact line number in the diff
  const lineEl = target.querySelector(
    `.d2h-code-linenumber:has(+ .d2h-code-line) .line-num2[data-line-number="${lineNumber}"], ` +
    `td.d2h-code-linenumber .line-num2[data-line-number="${lineNumber}"]`
  );

  if (lineEl) {
    const row = lineEl.closest("tr") || lineEl.closest(".d2h-code-line");
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.add("highlight-flash");
      setTimeout(() => row.classList.remove("highlight-flash"), 2000);
      return;
    }
  }

  // Fallback: scroll to the hunk group itself
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.add("highlight-flash");
  setTimeout(() => target.classList.remove("highlight-flash"), 2000);
}

export function getFileStats(file) {
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
