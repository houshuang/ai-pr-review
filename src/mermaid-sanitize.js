/**
 * Sanitize Mermaid diagram source to fix common syntax issues
 * from AI-generated diagrams (pipes in labels, unescaped special chars, etc.).
 *
 * Works in both Node.js and browser environments.
 */

// Characters that break Mermaid parsing when unquoted inside node labels
const NEEDS_QUOTING = /[|#<>]/;

/**
 * Quote unquoted node labels that contain characters Mermaid would misparse.
 * Converts e.g. A[text with | pipe] → A["text with | pipe"]
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

      // Quote square-bracket labels: A[text] → A["text"]
      line = line.replace(
        /\b([A-Za-z_]\w*)\[(?!")([^\]]+)\]/g,
        (match, id, label) => {
          if (NEEDS_QUOTING.test(label)) {
            return `${id}["${label.replace(/"/g, "&quot;")}"]`;
          }
          return match;
        }
      );

      // Quote round-bracket labels: A(text) → A("text")
      line = line.replace(
        /\b([A-Za-z_]\w*)\((?!")([^)]+)\)/g,
        (match, id, label) => {
          if (NEEDS_QUOTING.test(label)) {
            return `${id}("${label.replace(/"/g, "&quot;")}")`;
          }
          return match;
        }
      );

      // Quote curly-bracket labels: A{text} → A{"text"}
      line = line.replace(
        /\b([A-Za-z_]\w*)\{(?!")([^}]+)\}/g,
        (match, id, label) => {
          if (NEEDS_QUOTING.test(label)) {
            return `${id}{"${label.replace(/"/g, "&quot;")}"}`;
          }
          return match;
        }
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
