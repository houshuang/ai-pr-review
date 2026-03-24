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
