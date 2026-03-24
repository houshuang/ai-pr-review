import { h } from "preact";
import { useCallback } from "preact/hooks";
import {
  data, diffViewMode, showComments, isGitHubPR, getProgress, actionPanelOpen,
} from "../state";
import { exportStaticHtml } from "../api";
import { toggleChat, chatOpen } from "./ChatThread";

export function BottomBar() {
  const progress = getProgress();
  const commentCount = data.value?.comments?.length || 0;
  const gh = isGitHubPR();
  const mode = diffViewMode.value;
  const pctWidth = progress.hunksTotal ? Math.round((progress.hunksReviewed / progress.hunksTotal) * 100) : 0;

  const handleModeChange = useCallback((newMode) => {
    diffViewMode.value = newMode;
  }, []);

  const handleToggleComments = useCallback(() => {
    showComments.value = !showComments.value;
  }, []);

  const handleExport = useCallback(() => {
    exportStaticHtml().catch((err) => alert("Export failed: " + err.message));
  }, []);

  const handleActionPanel = useCallback(() => {
    actionPanelOpen.value = !actionPanelOpen.value;
  }, []);

  return (
    <div className="bottom-bar">
      <div className="bar-seg bar-green">
        <div className="bar-progress">
          <div className="bar-progress-fill" style={{ width: `${pctWidth}%` }}></div>
        </div>
        {" "}{progress.hunksReviewed}/{progress.hunksTotal}
      </div>
      <div className="bar-seg">{progress.reviewed}/{progress.total} sec</div>
      <div
        className={`bar-seg ${mode === "side-by-side" ? "bar-on" : ""} bar-clickable`}
        data-mode="side-by-side"
        onClick={() => handleModeChange("side-by-side")}
      >
        Split
      </div>
      <div
        className={`bar-seg ${mode === "unified" ? "bar-on" : ""} bar-clickable`}
        data-mode="unified"
        onClick={() => handleModeChange("unified")}
      >
        Unified
      </div>
      <div className={`bar-seg bar-clickable ${showComments.value ? "bar-on" : ""}`} id="btn-toggle-comments" onClick={handleToggleComments}>
        &#x1f4ac; {commentCount}
      </div>
      <div className="bar-seg bar-clickable" onClick={handleExport} title="Export static HTML (p)">
        Export
      </div>
      <div className={`bar-seg bar-clickable ${chatOpen.value ? "bar-on" : ""}`} onClick={toggleChat} title="AI Chat (a)">
        AI Chat
      </div>
      <div className="bar-right">
        {gh && (
          <div className="bar-seg bar-green bar-clickable" id="btn-approve" onClick={() => window.__openReviewModal?.("APPROVE", "Approve this PR")}>
            &#x2713; Approve
          </div>
        )}
        {gh && (
          <div className="bar-seg bar-red bar-clickable" id="btn-request-changes" onClick={() => window.__openReviewModal?.("REQUEST_CHANGES", "Request changes")}>
            &#x2715; Changes
          </div>
        )}
        <div className="bar-seg bar-clickable" id="btn-action-panel" onClick={handleActionPanel}>
          <kbd style={{ fontFamily: "var(--mono)", fontSize: "10px", padding: "1px 5px", background: "var(--bg)", border: "1px solid var(--border-light)", borderRadius: "3px" }}>.</kbd> Actions
        </div>
      </div>
    </div>
  );
}
