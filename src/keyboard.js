import {
  diffViewMode, darkMode, showComments, hideReviewed,
  collapsedSections, collapsedHunks, viewMode, data,
  reviewState, actionPanelOpen, currentSectionIndex,
  saveReviewState, clearSet, isGitHubPR, getFileCoverage,
} from "./state";
import { refreshComments, exportStaticHtml } from "./api";

export function getActionItems(callbacks) {
  const {
    openReviewModal,
    navigateToUnreviewed,
    navigateSection,
    reviewCurrentSection,
    toggleShortcutsModal,
  } = callbacks || {};

  const gh = isGitHubPR();
  const commentCount = data.value?.comments?.length || 0;
  const d = data.value;

  const closePanel = () => { actionPanelOpen.value = false; };

  return [
    { group: "Display", label: "Split diff", key: "s", action: () => { diffViewMode.value = "side-by-side"; }, active: diffViewMode.value === "side-by-side" },
    { group: "Display", label: "Unified diff", key: "u", action: () => { diffViewMode.value = "unified"; }, active: diffViewMode.value === "unified" },
    { group: "Display", label: "Dark mode", key: "d", action: () => { darkMode.value = !darkMode.value; } },
    { group: "Display", label: `Comments (${commentCount})`, key: "c", action: () => { showComments.value = !showComments.value; }, active: showComments.value },
    { group: "Display", label: "Hide reviewed", key: "h", action: () => { hideReviewed.value = !hideReviewed.value; }, active: hideReviewed.value },
    { group: "Sections", label: "Expand all", key: "e", action: () => { clearSet(collapsedSections); clearSet(collapsedHunks); saveReviewState(); } },
    { group: "Sections", label: "Collapse all", key: "w", action: () => { const next = new Set(collapsedSections.value); d.walkthrough.sections.forEach((s) => next.add(s.id)); collapsedSections.value = next; saveReviewState(); } },
    { group: "Navigate", label: "Next unreviewed", key: "n", action: () => { closePanel(); if (navigateToUnreviewed) navigateToUnreviewed(); } },
    { group: "Navigate", label: "Next section", key: "j", action: () => { closePanel(); if (navigateSection) navigateSection(1); } },
    { group: "Navigate", label: "Prev section", key: "k", action: () => { closePanel(); if (navigateSection) navigateSection(-1); } },
    { group: "Navigate", label: "Review current", key: "r", action: () => { closePanel(); if (reviewCurrentSection) reviewCurrentSection(); } },
    ...(gh ? [
      { group: "Review", label: "Approve PR", key: "a", action: () => { closePanel(); if (openReviewModal) openReviewModal("APPROVE", "Approve this PR"); } },
      { group: "Review", label: "Request changes", key: "x", action: () => { closePanel(); if (openReviewModal) openReviewModal("REQUEST_CHANGES", "Request Changes"); } },
      { group: "Review", label: "Refresh comments", key: "f", action: () => { closePanel(); refreshComments(); } },
    ] : []),
    ...(d?.meta?.url ? [
      { group: "Navigate", label: "Open PR on GitHub", key: "g", action: () => { closePanel(); window.open(d.meta.url, "_blank"); } },
    ] : []),
    { group: "Review", label: "Reset progress", key: "0", action: () => { closePanel(); if (confirm("Reset all review progress?")) { reviewState.value = {}; saveReviewState(); } } },
    { group: "View", label: "Editorial", key: "1", action: () => { viewMode.value = "editorial"; }, active: viewMode.value === "editorial" },
    { group: "View", label: "Sidebar", key: "2", action: () => { viewMode.value = "sidebar"; }, active: viewMode.value === "sidebar" },
    { group: "View", label: "Focus", key: "3", action: () => { viewMode.value = "focus"; }, active: viewMode.value === "focus" },
    { group: "View", label: "Split", key: "4", action: () => { viewMode.value = "split"; }, active: viewMode.value === "split" },
    { group: "View", label: "Developer", key: "5", action: () => { viewMode.value = "developer"; }, active: viewMode.value === "developer" },
    { group: "View", label: "Dashboard", key: "6", action: () => { viewMode.value = "dashboard"; }, active: viewMode.value === "dashboard" },
    { group: "Export", label: "Export static HTML", key: "p", action: () => { closePanel(); exportStaticHtml().catch((err) => alert("Export failed: " + err.message)); } },
    { group: "Help", label: "Shortcuts", key: "?", action: () => { closePanel(); if (toggleShortcutsModal) toggleShortcutsModal(); } },
  ];
}
