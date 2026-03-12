import { h } from "preact";
import { data, reviewState, viewMode, currentSectionIndex, getProgress, getFileCoverage } from "../../state";
import { esc } from "../../utils";
import { getActionItems } from "../../keyboard";
import { ActionPanel } from "../ActionPanel";
import { Header } from "../Header";
import { ProgressBar } from "../ProgressBar";
import { CoverageBar } from "../CoverageBar";
import { ReviewsSummary } from "../ReviewsSummary";
import { FileMap } from "../FileMap";
import { Footer } from "../Footer";
import { BottomBar } from "../BottomBar";
import { ReviewModal } from "../ReviewModal";

export function DashboardLayout({ callbacks }) {
  const d = data.value;
  const wt = d.walkthrough;
  const rs = reviewState.value;
  const progress = getProgress();
  const coverage = getFileCoverage(wt);
  const items = getActionItems(callbacks);
  const sections = wt.sections || [];

  const handleCardClick = (sectionIndex) => {
    currentSectionIndex.value = sectionIndex + 1; // +1 for overview
    viewMode.value = "focus";
  };

  const handleRemainingClick = () => {
    currentSectionIndex.value = sections.length + 1;
    viewMode.value = "focus";
  };

  return (
    <div>
      <ActionPanel items={items} />
      <div class="page-container">
        <Header />
        <ProgressBar progress={progress} />
        <CoverageBar coverage={coverage} />
        <ReviewsSummary />
        <div class="dashboard-grid">
          {sections.map((s, i) => {
            const reviewed = rs[s.id]?.reviewed;
            const fileCount = new Set(s.hunks?.map((h) => h.file) || []).size;
            const topImp = s.hunks?.find((h) => h.importance === "critical")
              ? "critical"
              : s.hunks?.find((h) => h.importance === "important")
                ? "important"
                : "supporting";
            return (
              <div
                key={s.id}
                class={`dashboard-card ${reviewed ? "reviewed" : ""}`}
                onClick={() => handleCardClick(i)}
              >
                <div class="dashboard-card-header">
                  <span class="dashboard-num">{String(i + 1).padStart(2, "0")}</span>
                  <span class={`dashboard-status ${reviewed ? "done" : ""}`}>{reviewed ? "\u2713" : "\u25CB"}</span>
                </div>
                <h3 class="dashboard-card-title">{esc(s.title)}</h3>
                <div class="dashboard-card-meta">
                  <span class={`hunk-importance importance-badge-${topImp}`}>{topImp}</span>
                  <span>{fileCount} file{fileCount !== 1 ? "s" : ""}</span>
                  <span>{s.hunks?.length || 0} hunks</span>
                </div>
              </div>
            );
          })}
          {coverage.uncoveredCount > 0 && (() => {
            const revRemaining = rs["__remaining"]?.reviewed;
            return (
              <div
                class={`dashboard-card remaining ${revRemaining ? "reviewed" : ""}`}
                onClick={handleRemainingClick}
              >
                <div class="dashboard-card-header">
                  <span class="dashboard-num">+</span>
                  <span class={`dashboard-status ${revRemaining ? "done" : ""}`}>{revRemaining ? "\u2713" : "\u25CB"}</span>
                </div>
                <h3 class="dashboard-card-title">Remaining Changes</h3>
                <div class="dashboard-card-meta"><span>{coverage.uncoveredCount} files not in walkthrough</span></div>
              </div>
            );
          })()}
        </div>
        <FileMap />
        <Footer />
      </div>
      <BottomBar />
      <ReviewModal />
    </div>
  );
}
