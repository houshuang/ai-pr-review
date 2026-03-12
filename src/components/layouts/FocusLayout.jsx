import { h } from "preact";
import { data, reviewState, currentSectionIndex, getFileCoverage } from "../../state";
import { esc } from "../../utils";
import { getActionItems } from "../../keyboard";
import { ActionPanel } from "../ActionPanel";
import { Overview } from "../Overview";
import { Section } from "../Section";
import { RemainingChanges } from "../RemainingChanges";
import { ViewSwitcher } from "../ViewSwitcher";
import { BottomBar } from "../BottomBar";
import { ReviewModal } from "../ReviewModal";

export function FocusLayout({ callbacks }) {
  const d = data.value;
  const wt = d.walkthrough;
  const meta = d.meta;
  const rs = reviewState.value;
  const coverage = getFileCoverage(wt);
  const items = getActionItems(callbacks);
  const sections = wt.sections || [];
  const totalSteps = sections.length + (coverage.uncoveredCount > 0 ? 1 : 0) + 1;
  const idx = Math.min(currentSectionIndex.value, totalSteps - 1);

  let sectionContent;
  if (idx === 0) {
    sectionContent = <Overview />;
  } else if (idx <= sections.length) {
    sectionContent = <Section section={sections[idx - 1]} index={idx - 1} />;
  } else {
    sectionContent = <RemainingChanges coverage={coverage} />;
  }

  const handlePrev = () => {
    currentSectionIndex.value = Math.max(0, currentSectionIndex.value - 1);
  };

  const handleNext = () => {
    currentSectionIndex.value = currentSectionIndex.value + 1;
  };

  const handleDotClick = (step) => {
    currentSectionIndex.value = step;
  };

  return (
    <div>
      <ActionPanel items={items} />
      <div class="layout-focus">
        <div class="focus-topbar">
          <span class="focus-title">{esc(wt.title)}</span>
          <span class="focus-meta">{meta.changedFiles} files &middot; +{meta.additions} -{meta.deletions}</span>
          <span style="flex:1"></span>
          <div class="focus-dots">
            <span
              class={`focus-dot ${idx === 0 ? "active" : ""}`}
              onClick={() => handleDotClick(0)}
              title="Overview"
            >&#9675;</span>
            {sections.map((s, i) => {
              const reviewed = rs[s.id]?.reviewed;
              return (
                <span
                  key={s.id}
                  class={`focus-dot ${idx === i + 1 ? "active" : ""} ${reviewed ? "reviewed" : ""}`}
                  onClick={() => handleDotClick(i + 1)}
                  title={esc(s.title)}
                >{i + 1}</span>
              );
            })}
            {coverage.uncoveredCount > 0 && (
              <span
                class={`focus-dot ${idx === sections.length + 1 ? "active" : ""}`}
                onClick={() => handleDotClick(sections.length + 1)}
                title="Remaining"
              >+</span>
            )}
          </div>
          <span style="flex:1"></span>
          <ViewSwitcher />
        </div>
        <div class="focus-content">
          <div class="page-container" style="max-width:900px">
            {sectionContent}
            <div class="focus-bottom-nav">
              <button class="btn" id="btn-prev-section" disabled={idx === 0} onClick={handlePrev}>&larr; Previous</button>
              <span class="focus-counter">{idx + 1} / {totalSteps}</span>
              <button class="btn btn-primary" id="btn-next-section" disabled={idx >= totalSteps - 1} onClick={handleNext}>Next &rarr;</button>
            </div>
          </div>
        </div>
      </div>
      <BottomBar />
      <ReviewModal />
    </div>
  );
}
