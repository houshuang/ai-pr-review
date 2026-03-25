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
        <div className="callout insight">
          <span className="callout-label">Review Tips</span>
          <ul>
            {wt.review_tips.map((t, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: linkFileRefs(md(t)) }} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
