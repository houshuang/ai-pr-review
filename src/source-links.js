const citation = /\b(base(?:\s*:\s*|\s+))?([\w./-]+\.\w{1,10}):(\d+)(?:[-–](\d+))?/g;

export function linkSourceReferences(html) {
  let protectedDepth = 0;
  let preceding = "";
  return html
    .split(/(<[^>]*>)/g)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<(?:pre|a)\b/i.test(part)) {
          protectedDepth++;
        }
        if (/^<\/(?:pre|a)\s*>/i.test(part)) {
          protectedDepth--;
        }
        return part;
      }
      if (protectedDepth) {
        return part;
      }
      const rendered = part.replace(citation, (match, base, path, line, end, offset) => {
        if (
          path.startsWith("/") ||
          path.split("/").includes("..") ||
          Number(line) < 1 ||
          (end && Number(end) < Number(line))
        ) {
          return match;
        }
        if (/[:/]/.test(part[offset - 1] || "")) {
          return match;
        }
        const revision =
          base || (offset === 0 && /\bbase\s*:?\s*$/.test(preceding)) ? "base" : "head";
        const filename = path.split("/").pop();
        const label = `${filename}:${line}${end ? `–${end}` : ""}`;
        return `<a class="file-ref-link" href="#source" data-file-ref="${path}" data-line="${line}" data-end-line="${end || line}" data-revision="${revision}" aria-label="Preview ${revision} source ${path}:${line}${end ? `-${end}` : ""}"><span>${label}</span>${revision === "base" ? '<span class="source-revision-badge">base</span>' : ""}</a>`;
      });
      preceding = part;
      return rendered;
    })
    .join("");
}
