/**
 * Sanitize Mermaid diagram source to fix common syntax issues
 * from AI-generated diagrams (pipes in labels, unescaped special chars, etc.).
 *
 * Works in both Node.js and browser environments.
 */

// Characters that break Mermaid parsing when unquoted inside node labels
const NEEDS_QUOTING = /[|#<>"]/;

/**
 * Quote unquoted node labels that contain characters Mermaid would misparse.
 * Converts e.g. A[text with | pipe] → A["text with | pipe"]
 *
 * Uses Mermaid's own entity syntax (#quot;) for escaping inner double-quotes,
 * NOT HTML entities (&quot;) which Mermaid doesn't understand.
 */
export function sanitizeMermaidSource(source) {
  if (!source) return source;

  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      // Skip Mermaid directives and structural keywords
      if (
        !trimmed ||
        /^%%/.test(trimmed) ||
        /^(flowchart|graph|subgraph|end|classDef|style|click|linkStyle|direction)\b/.test(
          trimmed
        )
      ) {
        return line;
      }

      // Normalize unicode arrows to standard Mermaid arrows
      line = line.replace(/\s*[─━—–]{1,3}[→⟶>]\s*/g, " --> ");
      line = line.replace(/\s*[─━—–]{1,3}[⟹>]\s*/g, " ==> ");
      // Also fix &quot; that may have leaked from prior broken sanitization
      line = line.replace(/&quot;/g, "#quot;");

      // Quote square-bracket labels: A[text] → A["text"]
      line = line.replace(
        /\b([A-Za-z_]\w*)\[(?!")([^\]]+)\]/g,
        (match, id, label) => {
          if (NEEDS_QUOTING.test(label)) {
            return `${id}["${label.replace(/"/g, "#quot;")}"]`;
          }
          return match;
        }
      );

      // Quote round-bracket labels: A(text) → A("text")
      line = line.replace(
        /\b([A-Za-z_]\w*)\((?!")([^)]+)\)/g,
        (match, id, label) => {
          if (NEEDS_QUOTING.test(label)) {
            return `${id}("${label.replace(/"/g, "#quot;")}")`;
          }
          return match;
        }
      );

      // Quote curly-bracket labels: A{text} → A{"text"}
      line = line.replace(
        /\b([A-Za-z_]\w*)\{(?!")([^}]+)\}/g,
        (match, id, label) => {
          if (NEEDS_QUOTING.test(label)) {
            return `${id}{"${label.replace(/"/g, "#quot;")}"}`;
          }
          return match;
        }
      );

      // Escape inner double-quotes inside already-quoted labels.
      // Uses negative lookahead (?!"\]) to stop at the node's closing delimiter
      // instead of greedy (.+) which would match across multiple nodes on one line.
      line = line.replace(
        /\b([A-Za-z_]\w*)\["((?:(?!"\]).)*)"\]/g,
        (match, id, label) => label.includes('"') ? `${id}["${label.replace(/"/g, "#quot;")}"]` : match
      );
      line = line.replace(
        /\b([A-Za-z_]\w*)\("((?:(?!"\)).)*)"\)/g,
        (match, id, label) => label.includes('"') ? `${id}("${label.replace(/"/g, "#quot;")}")` : match
      );
      line = line.replace(
        /\b([A-Za-z_]\w*)\{"((?:(?!"\}).)*)"\}/g,
        (match, id, label) => label.includes('"') ? `${id}{"${label.replace(/"/g, "#quot;")}"}` : match
      );

      return line;
    })
    .join("\n");
}

/**
 * Sanitize all diagram fields in a walkthrough object (mutates in place).
 */
export function sanitizeWalkthroughDiagrams(walkthrough) {
  if (!walkthrough) return walkthrough;

  if (walkthrough.architecture_diagram) {
    walkthrough.architecture_diagram = sanitizeMermaidSource(
      walkthrough.architecture_diagram
    );
  }

  if (walkthrough.sections) {
    for (const section of walkthrough.sections) {
      if (section.diagram) {
        section.diagram = sanitizeMermaidSource(section.diagram);
      }
    }
  }

  return walkthrough;
}
