import { h } from "preact";
import { data } from "../state";

export function CommitTimeline() {
  const d = data.value;
  const commits = d?.gitHistory?.commits;
  if (!commits?.length) return null;

  return (
    <details className="commit-timeline">
      <summary className="commit-timeline-summary">
        {commits.length} commit{commits.length > 1 ? "s" : ""} in this PR
      </summary>
      <ol className="commit-list">
        {commits.map((c, i) => (
          <li key={i} className="commit-item">
            <code className="commit-sha">{c.sha}</code>
            <span className="commit-msg">{c.message}</span>
            <span className="commit-author">{c.author}</span>
            <span className="commit-date">{new Date(c.date).toLocaleDateString()}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
