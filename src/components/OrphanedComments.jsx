import { h } from "preact";
import { data, parsedFiles } from "../state";
import { FileComments } from "./FileComments";

export function OrphanedComments({ coverage }) {
  const d = data.value;
  if (!d?.comments?.length) return null;

  const pf = parsedFiles.value;
  const allDiffFiles = new Set(Object.keys(pf));
  const allWalkthroughFiles = new Set();
  if (d.walkthrough?.sections) {
    for (const s of d.walkthrough.sections) {
      for (const h of s.hunks || []) {
        allWalkthroughFiles.add(h.file);
      }
    }
  }

  const orphaned = d.comments.filter((c) => {
    const inDiff = [...allDiffFiles].some((f) => f === c.path || f.endsWith(c.path) || c.path.endsWith(f));
    const inWalkthrough = [...allWalkthroughFiles].some((f) => f === c.path || f.endsWith(c.path) || c.path.endsWith(f));
    const inUncovered = (coverage?.uncovered || []).some((f) => f === c.path || f.endsWith(c.path) || c.path.endsWith(f));
    return !inWalkthrough && !inUncovered;
  });

  if (!orphaned.length) return null;

  // Group by file
  const byFile = new Map();
  for (const c of orphaned) {
    if (!byFile.has(c.path)) byFile.set(c.path, []);
    byFile.get(c.path).push(c);
  }

  return (
    <section id="section-orphaned-comments" className="review-section">
      <span className="section-number">Review Comments</span>
      <h2>Comments on Other Files</h2>
      <div className="section-body">
        <div className="narrative">
          <p>These review comments reference files not directly shown in the diff above.</p>
        </div>
        {[...byFile.entries()].map(([filePath, comments]) => (
          <div key={filePath} className="hunk-group importance-important">
            <div className="hunk-header">
              <span className="hunk-file">{filePath}</span>
              <span className="hunk-count">{comments.length} comment{comments.length > 1 ? "s" : ""}</span>
            </div>
            <FileComments filePath={filePath} />
          </div>
        ))}
      </div>
    </section>
  );
}
