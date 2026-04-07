import { h } from "preact";
import { useRef } from "preact/hooks";
import { data } from "../state";
import { md, linkFileRefs } from "../utils";
import { useMermaid } from "../mermaid";

export function Overview() {
  const d = data.value;
  if (!d) return null;
  const wt = d.walkthrough;
  const ref = useRef();
  useMermaid(ref);

  return (
    <section id="section-overview" ref={ref}>
      <span className="section-number">Overview</span>
      <h2>The Big Picture</h2>
      <div className="narrative" dangerouslySetInnerHTML={{ __html: md(wt.overview) }} />

      {wt.architecture_diagram && (
        <div className="diagram-container">
          <div className="diagram-label">Architecture</div>
          <div className="mermaid-source">{wt.architecture_diagram}</div>
        </div>
      )}

      {wt.review_tips?.length > 0 && (
        <div className="review-tips">
          <h3 className="review-tips-title">Review Tips</h3>
          <ul className="review-tips-list">
            {wt.review_tips.map((t, i) => {
              const isObj = typeof t === "object" && t !== null;
              const status = isObj ? t.status : null;
              const tipText = isObj ? t.tip : t;
              const finding = isObj ? t.finding : null;
              const icon = status === "verified" ? "✓" : status === "concern" ? "⚠" : status === "info" ? "ℹ" : null;
              return (
                <li key={i} className={`review-tip ${status || "legacy"}`}>
                  {icon && <span className={`tip-icon tip-${status}`}>{icon}</span>}
                  <div className="tip-content">
                    <span className="tip-text" dangerouslySetInnerHTML={{ __html: linkFileRefs(md(tipText)) }} />
                    {finding && <span className="tip-finding" dangerouslySetInnerHTML={{ __html: linkFileRefs(md(finding)) }} />}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
