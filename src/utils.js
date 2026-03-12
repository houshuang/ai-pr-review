export function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function md(text) {
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
