import { h } from "preact";
import { data } from "../state";
import { md, timeAgo } from "../utils";

export function ReviewsSummary() {
  const d = data.value;
  if (!d?.reviews?.length) return null;

  const reviews = d.reviews.filter((r) => r.state !== "PENDING" && r.state !== "DISMISSED");
  if (!reviews.length) return null;

  return (
    <div className="reviews-summary">
      {reviews.map((r) => {
        const stateClass = r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes-requested" : "commented";
        const stateLabel = r.state === "APPROVED" ? "Approved" : r.state === "CHANGES_REQUESTED" ? "Changes requested" : "Commented";
        return (
          <div key={r.id} className={`review-item review-${stateClass}`}>
            <span className="review-author">{r.user}</span>
            <span className="review-state">{stateLabel}</span>
            <span className="review-time">{timeAgo(r.submittedAt)}</span>
            {r.body && <div className="review-body" dangerouslySetInnerHTML={{ __html: md(r.body) }} />}
          </div>
        );
      })}
    </div>
  );
}
