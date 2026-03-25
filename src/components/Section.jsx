import { h } from "preact";
import { useRef, useCallback } from "preact/hooks";
import { useMermaid } from "../mermaid";
import {
  reviewState, collapsedSections, hideReviewed,
  setReviewed, toggleSet, addToSet, saveReviewState,
} from "../state";
import { md, linkFileRefs } from "../utils";
import { Callout } from "./Callout";
import { HunkGroup } from "./HunkGroup";

export function Section({ section, index }) {
  const rs = reviewState.value;
  const reviewed = rs[section.id]?.reviewed;
  const collapsed = collapsedSections.value.has(section.id);
  const ref = useRef();
  useMermaid(ref);

  if (hideReviewed.value && reviewed) return null;

  const fileCount = new Set(section.hunks?.map((h) => h.file) || []).size;

  // Group hunks by file
  const fileGroups = new Map();
  if (section.hunks) {
    for (const hunk of section.hunks) {
      if (!fileGroups.has(hunk.file)) fileGroups.set(hunk.file, []);
      fileGroups.get(hunk.file).push(hunk);
    }
  }

  const handleCollapse = useCallback((e) => {
    e.stopPropagation();
    toggleSet(collapsedSections, section.id);
    saveReviewState();
  }, [section.id]);

  const handleHeaderClick = useCallback((e) => {
    if (e.target.closest(".review-checkbox") || e.target.closest(".collapse-toggle")) return;
    toggleSet(collapsedSections, section.id);
    saveReviewState();
  }, [section.id]);

  const handleTopReview = useCallback((e) => {
    const checked = e.target.checked;
    setReviewed(section.id, checked);
    if (checked) {
      addToSet(collapsedSections, section.id);
      const el = document.getElementById(`section-${section.id}`);
      if (el) setTimeout(() => el.scrollIntoView({ block: "start" }), 0);
    }
  }, [section.id]);

  const handleBottomReview = useCallback((checked) => {
    setReviewed(section.id, checked);
    if (checked) {
      addToSet(collapsedSections, section.id);
      const el = document.getElementById(`section-${section.id}`);
      if (el) setTimeout(() => el.scrollIntoView({ block: "start" }), 0);
    }
  }, [section.id]);

  return (
    <section
      id={`section-${section.id}`}
      className={`review-section ${reviewed ? "reviewed" : ""} ${collapsed ? "collapsed" : ""}`}
      ref={ref}
    >
      <div className="section-header" data-section={section.id} onClick={handleHeaderClick}>
        <div className="section-header-left">
          <span className="section-number">
            Section {String(index + 1).padStart(2, "0")}
            {fileCount > 0 ? ` \u00b7 ${fileCount} file${fileCount !== 1 ? "s" : ""}` : ""}
          </span>
          <h2>{section.title}</h2>
        </div>
        <div className="section-header-right">
          <label className="review-checkbox" title="Mark as reviewed">
            <input
              type="checkbox"
              checked={reviewed || false}
              data-section-review={section.id}
              onChange={handleTopReview}
            />
            <span className="review-checkbox-label">{reviewed ? "Reviewed \u2713" : "Mark reviewed"}</span>
          </label>
          <button
            className="btn btn-icon collapse-toggle"
            data-collapse={section.id}
            title={collapsed ? "Expand" : "Collapse"}
            onClick={handleCollapse}
          >
            {collapsed ? "\u25b6" : "\u25bc"}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="section-body">
          <div className="narrative" dangerouslySetInnerHTML={{ __html: linkFileRefs(md(section.narrative)) }} />

          {section.diagram && (
            <div className="diagram-container">
              <div className="diagram-label">Diagram</div>
              <div className="mermaid-source">{section.diagram}</div>
            </div>
          )}

          {section.callouts?.map((c, i) => (
            <Callout key={i} type={c.type} label={c.label} text={c.text} />
          ))}

          {section.hunks?.length > 0 && (
            <div className="hunks">
              {[...fileGroups.entries()].map(([filePath, fileHunks]) => (
                <HunkGroup key={filePath} filePath={filePath} fileHunks={fileHunks} sectionId={section.id} />
              ))}
            </div>
          )}

          <div className="section-footer">
            <label className="review-checkbox" title="Mark as reviewed">
              <input
                type="checkbox"
                checked={reviewed || false}
                data-section-review={section.id}
                onChange={(e) => handleBottomReview(e.target.checked)}
              />
              <span className="review-checkbox-label">{reviewed ? "Reviewed \u2713" : "Mark reviewed"}</span>
            </label>
          </div>
        </div>
      )}
    </section>
  );
}
