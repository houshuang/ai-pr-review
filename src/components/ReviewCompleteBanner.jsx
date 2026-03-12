import { h } from "preact";
import { useCallback } from "preact/hooks";
import { getProgress, isGitHubPR } from "../state";

export function ReviewCompleteBanner() {
  const progress = getProgress();
  if (progress.pct !== 100 || progress.total === 0) return null;

  const gh = isGitHubPR();

  const handleApprove = useCallback(() => {
    if (window.__openReviewModal) {
      window.__openReviewModal("APPROVE", "Approve this PR");
    }
  }, []);

  const handleRequestChanges = useCallback(() => {
    if (window.__openReviewModal) {
      window.__openReviewModal("REQUEST_CHANGES", "Request Changes");
    }
  }, []);

  return (
    <div className="review-complete-banner">
      <div className="review-complete-icon">&#x2713;</div>
      <div className="review-complete-text">
        <strong>Review complete</strong> &mdash; All {progress.total} sections reviewed.
        {gh ? " Ready to submit your review?" : ""}
      </div>
      {gh && (
        <div className="review-complete-actions">
          <button className="btn btn-sm btn-approve" id="btn-complete-approve" onClick={handleApprove}>Approve</button>
          <button className="btn btn-sm btn-request-changes" id="btn-complete-request-changes" onClick={handleRequestChanges}>Request Changes</button>
        </div>
      )}
    </div>
  );
}
