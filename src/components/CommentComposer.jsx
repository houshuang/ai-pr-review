import { h } from "preact";
import { useState, useCallback } from "preact/hooks";
import { isGitHubPR, lineSelection } from "../state";
import { postComment, postCommentRange } from "../api";


export function CommentComposer({ filePath }) {
  if (!isGitHubPR()) return null;

  const [body, setBody] = useState("");
  const [startLine, setStartLine] = useState("");
  const [endLine, setEndLine] = useState("");
  const [side, setSide] = useState("RIGHT");
  const [posting, setPosting] = useState(false);

  const fileName = filePath.split("/").pop();

  const handlePost = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed) return;

    const effectiveEndLine = endLine ? parseInt(endLine) : (startLine ? parseInt(startLine) : 1);
    const effectiveStartLine = startLine ? parseInt(startLine) : effectiveEndLine;

    setPosting(true);

    try {
      if (effectiveStartLine !== effectiveEndLine) {
        await postCommentRange(filePath, effectiveStartLine, effectiveEndLine, side, trimmed);
      } else {
        await postComment(filePath, effectiveEndLine, side, trimmed);
      }
      setBody("");
      setStartLine("");
      setEndLine("");
      lineSelection.value = { file: null, startLine: null, endLine: null, side: "RIGHT" };
    } catch (err) {
      alert("Failed to post comment: " + err.message);
    } finally {
      setPosting(false);
    }
  }, [filePath, body, startLine, endLine, side]);

  return (
    <details className="comment-composer" data-file={filePath}>
      <summary className="comment-composer-toggle">Leave a review comment on {fileName}...</summary>
      <div className="comment-composer-body">
        <textarea
          className="comment-textarea"
          placeholder="Write your comment..."
          rows="2"
          data-comment-file={filePath}
          value={body}
          onInput={(e) => setBody(e.target.value)}
        />
        <div className="comment-actions">
          <input
            type="number"
            className="comment-line-input"
            placeholder="Start line"
            min="1"
            data-comment-start-line={filePath}
            value={startLine}
            onInput={(e) => setStartLine(e.target.value)}
          />
          <input
            type="number"
            className="comment-line-input"
            placeholder="End line"
            min="1"
            data-comment-end-line={filePath}
            value={endLine}
            onInput={(e) => setEndLine(e.target.value)}
          />
          <select
            className="comment-side-select"
            data-comment-side={filePath}
            value={side}
            onChange={(e) => setSide(e.target.value)}
          >
            <option value="RIGHT">New code</option>
            <option value="LEFT">Old code</option>
          </select>
          <button
            className="btn btn-sm"
            data-post-comment={filePath}
            onClick={handlePost}
            disabled={posting}
          >
            {posting ? "Posting..." : "Comment"}
          </button>
        </div>
      </div>
    </details>
  );
}
