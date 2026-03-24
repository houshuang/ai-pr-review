import { h } from "preact";
import { useRef } from "preact/hooks";
import { data, reviewState, setReviewed } from "../../state";
import { esc, md } from "../../utils";
import { getActionItems } from "../../keyboard";
import { useMermaid } from "../../mermaid";
import { ActionPanel } from "../ActionPanel";
import { Header } from "../Header";
import { Section } from "../Section";
import { BottomBar } from "../BottomBar";
import { ReviewModal } from "../ReviewModal";

export function SplitLayout({ callbacks }) {
  const contentRef = useRef();
  useMermaid(contentRef);
  const d = data.value;
  const wt = d.walkthrough;
  const meta = d.meta;
  const rs = reviewState.value;
  const items = getActionItems(callbacks);
  const sections = wt.sections || [];

  const handleReviewToggle = (sectionId, e) => {
    setReviewed(sectionId, e.target.checked);
  };

  return (
    <div>
      <ActionPanel items={items} />
      <div class="layout-split">
        <div class="split-header">
          <div class="page-container">
            <Header />
          </div>
        </div>
        <div class="split-panes" ref={contentRef}>
          <div class="split-left">
            <div class="split-section" data-split-section="overview">
              <div class="narrative" dangerouslySetInnerHTML={{ __html: md(wt.overview) }}></div>
            </div>
            {sections.map((s) => {
              const reviewed = rs[s.id]?.reviewed;
              return (
                <div key={s.id} class={`split-section ${reviewed ? "reviewed" : ""}`} data-split-section={esc(s.id)}>
                  <span class="section-number">{esc(s.title)}</span>
                  <div class="narrative" dangerouslySetInnerHTML={{ __html: md(s.narrative) }}></div>
                  {s.callouts?.length > 0 && s.callouts.map((c, ci) => (
                    <div key={ci} class={`callout ${esc(c.type)}`}>
                      <span class="callout-label">{esc(c.label)}</span>
                      <span dangerouslySetInnerHTML={{ __html: md(c.text) }}></span>
                    </div>
                  ))}
                  <label class="review-checkbox">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(e) => handleReviewToggle(s.id, e)}
                    />
                    <span class="review-checkbox-label">{reviewed ? "Reviewed \u2713" : "Mark reviewed"}</span>
                  </label>
                </div>
              );
            })}
          </div>
          <div class="split-right">
            <div class="split-section" data-split-section="overview">
              {wt.architecture_diagram && (
                <div class="diagram-container">
                  <div class="diagram-label">Architecture</div>
                  <div class="mermaid-source">{esc(wt.architecture_diagram)}</div>
                </div>
              )}
            </div>
            {sections.map((s) => (
              <div key={s.id} class="split-section" data-split-section={esc(s.id)}>
                {s.hunks?.length > 0 && (
                  <Section section={s} index={0} hunksOnly />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <BottomBar />
      <ReviewModal />
    </div>
  );
}
