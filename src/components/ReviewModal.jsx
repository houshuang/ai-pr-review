import { h } from "preact";
import { useState, useCallback } from "preact/hooks";
import { submitReview } from "../api";

export function ReviewModal() {
  const [visible, setVisible] = useState(false);
  const [eventType, setEventType] = useState("");
  const [title, setTitle] = useState("Submit Review");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Expose open method via a global so other components can trigger it
  // This replaces the old openReviewModal function
  if (typeof window !== "undefined") {
    window.__openReviewModal = (event, modalTitle) => {
      setEventType(event);
      setTitle(modalTitle);
      setBody("");
      setSubmitting(false);
      setVisible(true);
    };
  }

  const handleClose = useCallback(() => {
    setVisible(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (eventType === "REQUEST_CHANGES" && !body.trim()) {
      alert("Please provide a reason for requesting changes.");
      return;
    }

    setSubmitting(true);

    try {
      await submitReview(eventType, body.trim());
      setVisible(false);
    } catch (err) {
      alert("Failed to submit review: " + err.message);
      setSubmitting(false);
    }
  }, [eventType, body]);

  const btnClass = eventType === "APPROVE" ? "btn btn-approve" : "btn btn-request-changes";

  return (
    <div className="review-modal" id="review-modal" style={{ display: visible ? "flex" : "none" }}>
      <div className="review-modal-backdrop" onClick={handleClose} />
      <div className="review-modal-content">
        <h3 id="review-modal-title">{title}</h3>
        <textarea
          id="review-modal-body"
          rows="4"
          placeholder="Leave a comment (optional for approve)..."
          value={body}
          onInput={(e) => setBody(e.target.value)}
        />
        <div className="review-modal-actions">
          <button className="btn" onClick={handleClose}>Cancel</button>
          <button
            className={btnClass}
            id="review-modal-submit"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? "Submitting..." : title}
          </button>
        </div>
      </div>
    </div>
  );
}
