import { h } from "preact";
import { useCallback } from "preact/hooks";
import {
  data, reviewState, collapsedSections, collapsedHunks, diffViewMode,
  showComments, hideReviewed, parsedFiles,
  setReviewed, toggleSet, addToSet, saveReviewState, isGitHubPR,
} from "../state";
import { renderFileDiff } from "../diff";
import { getCommentThreads } from "../api";
import { esc, groupFilesByDirectory, getFileStats } from "../utils";
import { FileComments } from "./FileComments";
import { CommentComposer } from "./CommentComposer";
import { DiffView } from "./DiffView";

export function RemainingChanges({ coverage }) {
  if (!coverage || coverage.uncoveredCount === 0) return null;

  const rs = reviewState.value;
  const pf = parsedFiles.value;
  const collapsed = collapsedSections.value;
  const hunkCollapsed = collapsedHunks.value;
  const mode = diffViewMode.value;
  const comments = showComments.value;

  const reviewed = rs["__remaining"]?.reviewed;
  const isCollapsed = collapsed.has("__remaining");

  // Sort uncovered files by size
  const sortedUncovered = [...coverage.uncovered].sort((a, b) => {
    const statsA = pf[a] ? getFileStats(pf[a]) : { additions: 0, deletions: 0 };
    const statsB = pf[b] ? getFileStats(pf[b]) : { additions: 0, deletions: 0 };
    return (statsB.additions + statsB.deletions) - (statsA.additions + statsA.deletions);
  });

  const groups = groupFilesByDirectory(sortedUncovered);

  const handleHeaderClick = useCallback((e) => {
    if (e.target.closest(".review-checkbox") || e.target.closest(".collapse-toggle")) return;
    toggleSet(collapsedSections, "__remaining");
    saveReviewState();
  }, []);

  const handleCollapse = useCallback((e) => {
    e.stopPropagation();
    toggleSet(collapsedSections, "__remaining");
    saveReviewState();
  }, []);

  const handleReviewTop = useCallback((e) => {
    const checked = e.target.checked;
    setReviewed("__remaining", checked);
    if (checked) {
      addToSet(collapsedSections, "__remaining");
      const el = document.getElementById("section-remaining");
      if (el) setTimeout(() => el.scrollIntoView({ block: "start" }), 0);
    }
  }, []);

  const handleReviewBottom = useCallback((e) => {
    const checked = e.target.checked;
    setReviewed("__remaining", checked);
    if (checked) {
      addToSet(collapsedSections, "__remaining");
      const el = document.getElementById("section-remaining");
      if (el) setTimeout(() => el.scrollIntoView({ block: "start" }), 0);
    }
  }, []);

  return (
    <section
      id="section-remaining"
      className={`review-section remaining-section ${reviewed ? "reviewed" : ""} ${isCollapsed ? "collapsed" : ""}`}
    >
      <div className="section-header" data-section="__remaining" onClick={handleHeaderClick}>
        <div className="section-header-left">
          <span className="section-number">Remaining Changes</span>
          <h2>{coverage.uncoveredCount} files not in walkthrough</h2>
        </div>
        <div className="section-header-right">
          <label className="review-checkbox" title="Mark as reviewed">
            <input
              type="checkbox"
              checked={reviewed || false}
              data-section-review="__remaining"
              onChange={handleReviewTop}
            />
            <span className="review-checkbox-label">{reviewed ? "Reviewed \u2713" : "Mark reviewed"}</span>
          </label>
          <button
            className="btn btn-icon collapse-toggle"
            data-collapse="__remaining"
            title={isCollapsed ? "Expand" : "Collapse"}
            onClick={handleCollapse}
          >
            {isCollapsed ? "\u25b6" : "\u25bc"}
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <div className="section-body">
          <div className="narrative">
            <p>These files were changed in the PR but not featured in the AI walkthrough above. They may be mechanical changes (imports, re-exports, signature updates) or less critical modifications.</p>
          </div>

          {groups.map(([dir, files]) => (
            <RemainingGroup
              key={dir}
              dir={dir}
              files={files}
              rs={rs}
              pf={pf}
              hunkCollapsed={hunkCollapsed}
              mode={mode}
              comments={comments}
            />
          ))}

          <div className="section-footer">
            <label className="review-checkbox" title="Mark as reviewed">
              <input
                type="checkbox"
                checked={reviewed || false}
                data-section-review="__remaining"
                onChange={handleReviewBottom}
              />
              <span className="review-checkbox-label">{reviewed ? "Reviewed \u2713" : "Mark reviewed"}</span>
            </label>
          </div>
        </div>
      )}
    </section>
  );
}

function RemainingGroup({ dir, files, rs, pf, hunkCollapsed, mode, comments }) {
  const groupKey = `__remaining:${dir}`;
  const groupCollapsed = hunkCollapsed.has(groupKey);

  const handleGroupToggle = useCallback(() => {
    toggleSet(collapsedHunks, groupKey);
    saveReviewState();
  }, [groupKey]);

  return (
    <div className="remaining-group">
      <div className="remaining-group-header" data-hunk-toggle={groupKey} onClick={handleGroupToggle}>
        <span className="hunk-file">{dir || "(root)"}/</span>
        <span className="hunk-count">{files.length} file{files.length > 1 ? "s" : ""}</span>
        <span className="hunk-toggle-icon">{groupCollapsed ? "\u25b6" : "\u25bc"}</span>
      </div>

      {!groupCollapsed && files.map((filePath) => (
        <RemainingFile
          key={filePath}
          filePath={filePath}
          rs={rs}
          pf={pf}
          hunkCollapsed={hunkCollapsed}
          mode={mode}
          comments={comments}
        />
      ))}
    </div>
  );
}

function RemainingFile({ filePath, rs, pf, hunkCollapsed, mode, comments }) {
  const file = pf[filePath];
  const fileKey = `__remaining:file:${filePath}`;
  // Remaining files start collapsed by default (inverted: set = expanded)
  const fileCollapsed = !hunkCollapsed.has(fileKey);
  const fileReviewed = rs[`file:${filePath}`]?.reviewed;
  const fileComments = getCommentThreads(filePath);
  const fileName = filePath.split("/").pop();
  const stats = file ? getFileStats(file) : null;

  const handleFileToggle = useCallback(() => {
    toggleSet(collapsedHunks, fileKey);
    saveReviewState();
  }, [fileKey]);

  const handleFileReview = useCallback((e) => {
    e.stopPropagation();
    setReviewed(`file:${filePath}`, e.target.checked);
  }, [filePath]);

  return (
    <div className={`remaining-file ${fileReviewed ? "file-reviewed" : ""}`}>
      <div className="remaining-file-header" data-hunk-toggle={fileKey} onClick={handleFileToggle}>
        <label className="file-review-checkbox" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={fileReviewed || false}
            data-file-review={filePath}
            onChange={handleFileReview}
          />
        </label>
        <span className="remaining-file-name">{fileName}</span>
        {stats && <span className="remaining-file-stats">+{stats.additions} &minus;{stats.deletions}</span>}
        {fileComments.length > 0 && (
          <span className="remaining-file-comments">{fileComments.length} comment{fileComments.length > 1 ? "s" : ""}</span>
        )}
        <span className="hunk-toggle-icon">{fileCollapsed ? "\u25b6" : "\u25bc"}</span>
      </div>

      {!fileCollapsed && (
        <>
          {file && (
            <div className="hunk-diff" data-hunk-file={filePath}>
              <DiffView file={file} mode={mode} filePath={filePath} hunkKey={`__remaining:${filePath}`} fileHunks={null} showExpandBars={false} />
            </div>
          )}
          {comments && fileComments.length > 0 && <FileComments filePath={filePath} />}
          {isGitHubPR() && comments && <CommentComposer filePath={filePath} />}
        </>
      )}
    </div>
  );
}
