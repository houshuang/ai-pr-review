import { DescriptionButton } from "./DetailedDescription";
import { h } from "preact";
import { useCallback } from "preact/hooks";
import {
  data, reviewState, diffViewMode, collapsedHunks, showFullFile, showComments,
  findFile, getFragment, goToSection, isGitHubPR, setReviewed, toggleSet, saveReviewState,
  hideReviewed,
} from "../state";
import { filterFileToRanges } from "../diff";
import { fragmentLineLabel } from "../file-fragments";
import { linkFileRefs, md } from "../utils";
import { DiffView } from "./DiffView";
import { FileComments } from "./FileComments";
import { CommentComposer } from "./CommentComposer";

function SectionLink({ sectionId }) {
  const title = data.value?.walkthrough?.sections?.find((section) => section.id === sectionId)?.title || sectionId;
  return <button className="btn-link" onClick={() => goToSection(sectionId)}>{title}</button>;
}

function SectionLinks({ sectionIds }) {
  return sectionIds.map((sectionId, index) => (
    <>{index > 0 && ", "}<SectionLink key={sectionId} sectionId={sectionId} /></>
  ));
}

export function HunkGroup({ filePath, fileHunks, sectionId }) {
  const rs = reviewState.value;
  const mode = diffViewMode.value;
  const collapsed = collapsedHunks.value;
  const fullFile = showFullFile.value;
  const comments = showComments.value;
  const d = data.value;

  const file = findFile(filePath);
  const hunkKey = `${sectionId}:${filePath}`;
  const isCollapsed = collapsed.has(hunkKey);
  const hunkReviewed = rs[`hunk:${hunkKey}`]?.reviewed;

  if (hideReviewed.value && hunkReviewed) return null;

  // Determine highest importance
  const importanceOrder = { critical: 0, important: 1, supporting: 2, context: 3 };
  const topImportance = fileHunks.reduce((best, h) => {
    const hImp = h.importance || "important";
    return (importanceOrder[hImp] || 2) < (importanceOrder[best] || 2) ? hImp : best;
  }, fileHunks[0].importance || "important");

  // Line range summary
  const lineRanges = fileHunks
    .filter((h) => h.startLine)
    .map((h) => h.startLine === h.endLine ? `L${h.startLine}` : `L${h.startLine}\u2013${h.endLine}`)
    .join(", ");

  // File age / churn badges
  const age = d?.gitHistory?.fileAges?.[filePath];
  const churn = d?.gitHistory?.churn?.[filePath];

  const handleToggle = useCallback(() => {
    toggleSet(collapsedHunks, hunkKey);
    saveReviewState();
  }, [hunkKey]);

  const handleHunkReview = useCallback((e) => {
    e.stopPropagation();
    setReviewed(`hunk:${hunkKey}`, e.target.checked);
  }, [hunkKey]);

  const handleShowFull = useCallback((e) => {
    e.stopPropagation();
    toggleSet(showFullFile, hunkKey);
  }, [hunkKey]);

  const isFull = fullFile.has(hunkKey);
  const fragment = file ? getFragment(file, sectionId) : null;
  const inFragment = fragment && !isFull;
  const filteredFile = file ? (fragment ? fragment.file : filterFileToRanges(file, fileHunks)) : null;
  const canFilter = !fragment && file && filteredFile && filteredFile.blocks.length < file.blocks.length;
  const displayFile = file ? (isFull ? file : filteredFile) : null;
  const hasDiff = displayFile && !(inFragment && fragment.blocks.length === 0);

  let ageBadge = null;
  if (age) {
    const days = age.daysSince;
    let label, cls;
    if (days > 365) { label = `${Math.floor(days / 365)}y old`; cls = "age-old"; }
    else if (days > 90) { label = `${Math.floor(days / 30)}mo old`; cls = "age-moderate"; }
    else if (days > 7) { label = `${days}d old`; cls = "age-recent"; }
    if (label) {
      ageBadge = <span className={`file-age-badge ${cls}`} title={`Last modified ${age.lastModified?.split("T")[0]} by ${age.lastAuthor || "unknown"}`}>{label}</span>;
    }
  }

  let churnBadge = null;
  if (churn && churn.touchCount >= 2) {
    churnBadge = <span className="file-churn-badge" title={`Touched ${churn.touchCount} times across commits in this PR`}>{churn.touchCount}&times; revised</span>;
  }

  return (
    <div className={`hunk-group importance-${topImportance} ${hunkReviewed ? "hunk-reviewed" : ""}`}>
      <div className="hunk-header" data-hunk-toggle={hunkKey} onClick={handleToggle}>
        <label className="hunk-review-check" onClick={(e) => e.stopPropagation()} title="Mark file as reviewed">
          <input type="checkbox" checked={hunkReviewed || false} data-hunk-review={hunkKey} onChange={handleHunkReview} />
        </label>
        <span className="hunk-file">{filePath}</span>
        <span className="hunk-lines">{lineRanges}</span>
        <span className="hunk-count">{fileHunks.length} annotation{fileHunks.length > 1 ? "s" : ""}</span>
        {ageBadge}
        {churnBadge}
        <span className={`hunk-importance importance-badge-${topImportance}`}>{topImportance}</span>
        <DescriptionButton scope={{ kind: "file", path: filePath }} />
        <span className="hunk-toggle-icon">{isCollapsed ? "\u25b6" : "\u25bc"}</span>
      </div>

      {!isCollapsed && (
        <>
          {inFragment && fragment.elsewhere.map(({ hunk, sectionId: shownIn }) => (
            <div className={`hunk-annotation-inline annotation-${hunk.importance || "important"}`} key={`${hunk.startLine}-${hunk.endLine}`}>
              <span className="annotation-lines">{hunk.startLine === hunk.endLine ? `L${hunk.startLine}` : `L${hunk.startLine}\u2013${hunk.endLine}`}</span>
              <span dangerouslySetInnerHTML={{ __html: linkFileRefs(md(hunk.annotation || "")) }} />
              {shownIn && <div className="annotation-shown-in">Code in <SectionLink sectionId={shownIn} /></div>}
            </div>
          ))}
          {fragment && (
            <div className="diff-filter-notice">
              {isFull && <>Showing the whole file &middot; </>}
              {inFragment && hasDiff && <>Showing {fragmentLineLabel(fragment)} &middot; </>}
              {inFragment && hasDiff && fragment.others.length > 0 && <>Rest in <SectionLinks sectionIds={fragment.others} /> &middot; </>}
              <button className="btn-link" data-show-full={hunkKey} onClick={handleShowFull}>{isFull ? "Show only this part" : "Show whole file"}</button>
            </div>
          )}
          {hasDiff ? (
            <div className="hunk-diff" data-hunk-file={filePath} data-hunk-key={hunkKey}>
              {canFilter && !isFull && (
                <div className="diff-filter-notice">
                  Showing {filteredFile.blocks.length} of {file.blocks.length} hunks matching referenced lines &middot;{" "}
                  <button className="btn-link" data-show-full={hunkKey} onClick={handleShowFull}>Show all {file.blocks.length} hunks</button>
                </div>
              )}
              {canFilter && isFull && (
                <div className="diff-filter-notice">
                  Showing all {file.blocks.length} hunks &middot;{" "}
                  <button className="btn-link" data-show-full={hunkKey} onClick={handleShowFull}>Show only referenced hunks</button>
                </div>
              )}
              <DiffView file={displayFile} mode={mode} filePath={filePath} hunkKey={hunkKey} fileHunks={inFragment ? fragment.placed : fileHunks} showExpandBars={!inFragment} />
            </div>
          ) : !file ? (
            <div className="hunk-diff no-diff">File &quot;{filePath}&quot; not found in diff</div>
          ) : null}

          {comments && <FileComments filePath={filePath} showsLine={fragment?.showsLine} />}
          {isGitHubPR() && comments && <CommentComposer filePath={filePath} />}
        </>
      )}
    </div>
  );
}
