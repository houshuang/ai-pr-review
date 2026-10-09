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
      <div className="narrative" dangerouslySetInnerHTML={{ __html: linkFileRefs(md(wt.overview)) }} />

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
              const pending = isObj && t.pending;
              const tipText = isObj ? t.tip : t;
              const finding = isObj ? t.finding : null;
              const blocked = isObj && t.investigationState === "blocked";
              const complete = isObj && t.investigationState === "complete";
              const checks = isObj && Array.isArray(t.evidence?.tests) ? t.evidence.tests : [];
              const icon = status === "verified" ? "✓" : status === "concern" ? "⚠" : status === "info" ? "ℹ" : null;
              return (
                <li key={i} className={`review-tip ${status || "legacy"} ${pending ? "pending" : ""}`}>
                  {pending
                    ? <span className="tip-icon tip-pending" title="Investigating in the background"><span className="tip-spinner" /></span>
                    : icon && <span className={`tip-icon tip-${status}`}>{icon}</span>}
                  <div className="tip-content">
                    <span className="tip-text" dangerouslySetInnerHTML={{ __html: linkFileRefs(md(tipText)) }} />
                    {pending
                      ? <span className="tip-finding tip-finding-pending">Codex is checking the full code and running relevant tests…</span>
                      : finding && <span className="tip-finding" dangerouslySetInnerHTML={{ __html: linkFileRefs(md(finding)) }} />}
                    {!pending && (blocked || complete) && <span className="tip-finding">
                      {blocked ? "Check blocked · retries on the next review run" : status === "concern" ? "Full-code check complete · issue confirmed" : "Full-code check complete"}
                    </span>}
                    {!pending && checks.length > 0 && <details className="tip-finding">
                      <summary>Checks and test results</summary>
                      <ul>{checks.map((check, index) => <li key={index}>
                        <code>{check.command}</code> — {check.outcome}
                        {check.detail && <div>{check.detail}</div>}
                      </li>)}</ul>
                    </details>}
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
