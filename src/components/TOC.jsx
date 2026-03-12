import { h } from "preact";
import { useCallback } from "preact/hooks";
import { data, reviewState, getEstimatedReadTime, getCommentCountForSection, getFileCoverage } from "../state";
import { esc } from "../utils";

export function TOC() {
  const d = data.value;
  if (!d?.walkthrough?.sections?.length) return null;
  const wt = d.walkthrough;
  const rs = reviewState.value;
  const coverage = getFileCoverage(wt);

  const handleClick = useCallback((e, id) => {
    e.preventDefault();
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const sectionItems = wt.sections.map((s) => {
    const reviewed = rs[s.id]?.reviewed;
    const readTime = getEstimatedReadTime(s);
    const commentCount = getCommentCountForSection(s);
    const metaParts = [`${readTime} min`];
    if (commentCount > 0) metaParts.push(`${commentCount} comment${commentCount > 1 ? "s" : ""}`);

    return (
      <li key={s.id} className={reviewed ? "reviewed" : ""}>
        <a href={`#section-${s.id}`} onClick={(e) => handleClick(e, `section-${s.id}`)}>
          <span className="toc-title">{s.title}</span>
          {reviewed && <span className="check"> &#x2713;</span>}
          <span className="toc-meta">{metaParts.join(" \u00b7 ")}</span>
        </a>
      </li>
    );
  });

  const remainingReviewed = rs["__remaining"]?.reviewed;

  return (
    <nav className="toc">
      <ol>
        {sectionItems}
        {coverage && coverage.uncoveredCount > 0 && (
          <li className={remainingReviewed ? "reviewed" : ""}>
            <a href="#section-remaining" onClick={(e) => handleClick(e, "section-remaining")}>
              Remaining Changes ({coverage.uncoveredCount} files)
              {remainingReviewed && <span className="check"> &#x2713;</span>}
            </a>
          </li>
        )}
      </ol>
    </nav>
  );
}
