/**
 * Sanitize Mermaid diagram source to fix common syntax issues
 * from AI-generated diagrams (pipes in labels, unescaped special chars, etc.).
 *
 * Works in both Node.js and browser environments.
 */

// Characters that break Mermaid parsing when unquoted inside node labels
const NEEDS_QUOTING = /[|#<>"]/;

/**
 * Fix bracket-type mismatches: e.g. S5{"..."] → S5{"..."}.
 * The AI sometimes emits inconsistent open/close pairs on shape nodes;
 * Mermaid then errors with "expecting DIAMOND_STOP, got SQE" and friends.
 * We rewrite the closer to match the opener (open wins, since the shape
 * intent is carried by the opener and the close is the typo).
 *
 * Runs on the WHOLE source, not per-line: a quoted label may span multiple
 * lines (S5{"a\nb"]), so the opener and the mismatched closer can sit on
 * different lines. The quoted branch ([^"]*) matches across newlines.
 */
const CLOSER_FOR = { "[": "]", "{": "}", "(": ")" };
function fixBracketMismatch(source) {
  return source.replace(
    /\b([A-Za-z_]\w*)([\[\{\(])(?:("[^"]*")|([^\]\}\)]*?))([\]\}\)])/g,
    (match, id, open, quoted, unquoted, close) => {
      const want = CLOSER_FOR[open];
      if (close === want) return match;
      const content = quoted !== undefined ? quoted : unquoted;
      return `${id}${open}${content}${want}`;
    }
  );
}

/**
 * Quote unquoted node labels that contain characters Mermaid would misparse.
 * Converts e.g. A[text with | pipe] → A["text with | pipe"]
 *
 * Uses Mermaid's own entity syntax (#quot;) for escaping inner double-quotes,
 * NOT HTML entities (&quot;) which Mermaid doesn't understand.
 */
export function sanitizeMermaidSource(source) {
  if (!source) return source;

  // Whole-source pass: labels may span lines, so the opener and a mismatched
  // closer can land on different lines — a per-line matcher would miss it.
  source = fixBracketMismatch(source);

  return source
    .split("\n")
    .map((line) => {
      // Trailing whitespace on a subgraph header makes Mermaid 11
      // swallow the next line into the header and fail to parse.
      line = line.replace(/[ \t]+$/, "");
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

      // Strip stray excess close-brackets. AI sometimes emits e.g.
      //   START("[#quot;next op#quot;"))   ← one `(` but two `))`
      // Depth-aware so doubled shapes like `((...))` (circle), `[[...]]`
      // (subroutine), `{{...}}` (hexagon) survive. Chars inside `"..."` are
      // skipped (only literal " toggles; #quot; is six literal chars to the lexer).
      {
        const drop = new Set();
        const depth = { "(": 0, "[": 0, "{": 0 };
        const openFor = { ")": "(", "]": "[", "}": "{" };
        let inStr = false;
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (c === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (c in depth) depth[c]++;
          else if (c in openFor) {
            const o = openFor[c];
            if (depth[o] > 0) depth[o]--;
            else drop.add(i);
          }
        }
        if (drop.size) {
          let out = "";
          for (let i = 0; i < line.length; i++) if (!drop.has(i)) out += line[i];
          line = out;
        }
      }

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
