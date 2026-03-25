import { h } from "preact";
import { data, getProgress, reviewState } from "../state";


export function Header() {
  const d = data.value;
  if (!d) return null;
  const { walkthrough: wt, meta } = d;
  const progress = getProgress();

  const reviewerNames = (d.reviews || [])
    .filter((r) => r.state !== "PENDING" && r.state !== "DISMISSED" && r.user)
    .map((r) => r.user)
    .filter((v, i, a) => a.indexOf(v) === i);

  return (
    <header className="page-header">
      <div className="kicker">Code Review Walkthrough</div>
      <h1>{wt.title}</h1>
      <p className="subtitle">{wt.subtitle}</p>
      <div className="meta">
        {meta.author && (
          <span className="meta-item meta-author">by {meta.author}</span>
        )}
        {meta.url && (
          <span className="meta-item">
            <a href={meta.url} target="_blank">PR Link &#x2197;</a>
          </span>
        )}
        <span className="meta-item">{meta.headBranch} &rarr; {meta.baseBranch}</span>
        <span className="meta-item">+{meta.additions} &minus;{meta.deletions}</span>
        <span className="meta-item">{meta.changedFiles} files</span>
        <span className="meta-item">{progress.hunksReviewed}/{progress.hunksTotal} files reviewed</span>
        {reviewerNames.length > 0 && (
          <span className="meta-item meta-reviewers">Reviewers: {reviewerNames.join(", ")}</span>
        )}
      </div>
    </header>
  );
}
