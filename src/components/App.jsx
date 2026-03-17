import { h } from "preact";
import { useEffect, useCallback } from "preact/hooks";
import {
  data, parsedFiles, viewMode, darkMode, actionPanelOpen,
  reviewState, getFileCoverage, loadReviewState, applyAutoCollapse,
} from "../state";
import { parseDiff } from "../diff";
import { ensureMermaidLoaded } from "../mermaid";
import { getActionItems } from "../keyboard";
import { EditorialLayout } from "./layouts/EditorialLayout";
import { SidebarLayout } from "./layouts/SidebarLayout";
import { FocusLayout } from "./layouts/FocusLayout";
import { SplitLayout } from "./layouts/SplitLayout";
import { DashboardLayout } from "./layouts/DashboardLayout";
import { Landing } from "./Landing";
import { ChatThread, chatOpen, toggleChat } from "./ChatThread";

function getWalkthroughUrl() {
  const params = new URLSearchParams(window.location.search);
  const pr = params.get("pr");
  if (pr) return `/walkthroughs/${pr}.json`;
  return "/walkthrough-data.json";
}

export function App() {
  // Auto-load walkthrough data on mount
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(getWalkthroughUrl());
        if (resp.ok) {
          const json = await resp.json();
          data.value = json;
          parsedFiles.value = parseDiff(json.diff);
          loadReviewState();
          applyAutoCollapse();
          ensureMermaidLoaded();
        }
      } catch {
        // No data available, landing page will show
      }
    })();
  }, []);

  // Dark mode effect
  useEffect(() => {
    const isDark = darkMode.value || viewMode.value === "developer";
    document.documentElement.classList.toggle("dark", isDark);
  }, [darkMode.value, viewMode.value]);

  // View mode class effect
  useEffect(() => {
    document.documentElement.className = document.documentElement.className
      .replace(/\bview-\w+\b/g, "").trim();
    document.documentElement.classList.add(`view-${viewMode.value}`);
  }, [viewMode.value]);

  // Callback: open review modal
  const openReviewModal = useCallback((event, title) => {
    const modal = document.getElementById("review-modal");
    if (!modal) return;
    modal.dataset.event = event;
    const titleEl = document.getElementById("review-modal-title");
    if (titleEl) titleEl.textContent = title;
    const bodyEl = document.getElementById("review-modal-body");
    if (bodyEl) bodyEl.value = "";
    const submitBtn = document.getElementById("review-modal-submit");
    if (submitBtn) {
      submitBtn.textContent = title;
      submitBtn.disabled = false;
      submitBtn.className = event === "APPROVE" ? "btn btn-approve" : "btn btn-request-changes";
    }
    modal.style.display = "flex";
  }, []);

  // Callback: navigate to first unreviewed section
  const navigateToUnreviewed = useCallback(() => {
    const d = data.value;
    if (!d) return;
    const allSections = d.walkthrough?.sections || [];
    const coverage = getFileCoverage(d.walkthrough);
    const rs = reviewState.value;
    const sectionIds = allSections.map((s) => s.id);
    if (coverage.uncoveredCount > 0) sectionIds.push("__remaining");
    const firstUnreviewed = sectionIds.find((id) => !rs[id]?.reviewed);
    if (firstUnreviewed) {
      const targetId = firstUnreviewed === "__remaining" ? "section-remaining" : `section-${firstUnreviewed}`;
      const target = document.getElementById(targetId);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  // Callback: navigate to next/prev section
  const navigateSection = useCallback((direction) => {
    const sections = Array.from(document.querySelectorAll(".review-section"));
    if (!sections.length) return;
    const scrollY = window.scrollY + 100;
    let current = 0;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].offsetTop <= scrollY) current = i;
    }
    const next = direction > 0 ? Math.min(current + 1, sections.length - 1) : Math.max(current - 1, 0);
    sections[next].scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Callback: review current section
  const reviewCurrentSection = useCallback(() => {
    const sections = Array.from(document.querySelectorAll(".review-section"));
    const scrollY = window.scrollY + 100;
    let current = 0;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].offsetTop <= scrollY) current = i;
    }
    const sectionEl = sections[current];
    if (sectionEl) {
      const cb = sectionEl.querySelector("[data-section-review]");
      if (cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }, []);

  // Callback: toggle shortcuts modal
  const toggleShortcutsModal = useCallback(() => {
    let modal = document.getElementById("shortcuts-modal");
    if (modal) {
      modal.remove();
      return;
    }

    modal = document.createElement("div");
    modal.id = "shortcuts-modal";
    modal.className = "shortcuts-modal";
    modal.innerHTML = `
      <div class="shortcuts-modal-backdrop" data-close-shortcuts></div>
      <div class="shortcuts-modal-content">
        <h3>Keyboard Shortcuts</h3>
        <div class="shortcuts-list">
          <div class="shortcut-row"><kbd>j</kbd> / <kbd>k</kbd><span>Next / previous section</span></div>
          <div class="shortcut-row"><kbd>n</kbd><span>Jump to next unreviewed section</span></div>
          <div class="shortcut-row"><kbd>r</kbd><span>Toggle review on current section</span></div>
          <div class="shortcut-row"><kbd>e</kbd><span>Expand / collapse current section</span></div>
          <div class="shortcut-row"><kbd>a</kbd><span>Toggle AI chat thread</span></div>
          <div class="shortcut-row"><kbd>?</kbd><span>Show this help</span></div>
        </div>
        <button class="btn btn-sm" data-close-shortcuts>Close</button>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelectorAll("[data-close-shortcuts]").forEach((el) => {
      el.addEventListener("click", () => modal.remove());
    });
  }, []);

  const callbacks = {
    openReviewModal,
    navigateToUnreviewed,
    navigateSection,
    reviewCurrentSection,
    toggleShortcutsModal,
  };

  // Keyboard handler
  useEffect(() => {
    const handleKeyboard = (e) => {
      if (!data.value) return;

      // Escape closes action panel
      if (e.key === "Escape") {
        if (actionPanelOpen.value) {
          actionPanelOpen.value = false;
          e.preventDefault();
          return;
        }
      }

      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || window.__chatInputActive) return;

      // "." toggles action panel
      if (e.key === ".") {
        e.preventDefault();
        actionPanelOpen.value = !actionPanelOpen.value;
        return;
      }

      // When action panel is open, single-key shortcuts execute actions
      if (actionPanelOpen.value) {
        const items = getActionItems(callbacks);
        const match = items.find((item) => item.key === e.key);
        if (match) {
          e.preventDefault();
          match.action();
          return;
        }
      }

      // Toggle chat
      if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        toggleChat();
        return;
      }

      // Direct shortcuts (work without panel open too)
      const directKeys = { j: true, k: true, n: true, r: true, e: true, "?": true };
      if (directKeys[e.key]) {
        const items = getActionItems(callbacks);
        const match = items.find((item) => item.key === e.key);
        if (match) {
          e.preventDefault();
          match.action();
          return;
        }
      }
    };

    document.addEventListener("keydown", handleKeyboard);
    return () => document.removeEventListener("keydown", handleKeyboard);
  }, [callbacks]);

  // If no data, show landing page
  if (!data.value) {
    return <Landing />;
  }

  const vm = viewMode.value;

  const Layout = {
    sidebar: SidebarLayout,
    focus: FocusLayout,
    split: SplitLayout,
    dashboard: DashboardLayout,
  }[vm] || EditorialLayout;

  return (
    <>
      <Layout callbacks={callbacks} />
      <ChatThread />
    </>
  );
}
