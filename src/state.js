import { signal, computed, effect } from "@preact/signals";

// ─── Core State (signals) ────────────────────────────
export const data = signal(null);
export const parsedFiles = signal({});
export const reviewState = signal({});
export const diffViewMode = signal("side-by-side");
export const collapsedSections = signal(new Set());
export const collapsedHunks = signal(new Set());
export const pendingComments = signal([]);
export const showComments = signal(true);
export const hideReviewed = signal(false);
export const showFullFile = signal(new Set());
export const lineSelection = signal({ file: null, startLine: null, endLine: null, side: "RIGHT" });
export const fileContentCache = new Map(); // not reactive, just a cache
export const viewMode = signal(localStorage.getItem("review-tool-view") || "editorial");
export const darkMode = signal(localStorage.getItem("review-tool-dark") === "true");
export const currentSectionIndex = signal(0);
export const actionPanelOpen = signal(false);

let autoCollapseApplied = false;

// ─── Set Helpers ─────────────────────────────────────
export function toggleSet(sig, key) {
  const next = new Set(sig.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  sig.value = next;
}

export function addToSet(sig, key) {
  if (sig.value.has(key)) return;
  const next = new Set(sig.value);
  next.add(key);
  sig.value = next;
}

export function deleteFromSet(sig, key) {
  if (!sig.value.has(key)) return;
  const next = new Set(sig.value);
  next.delete(key);
  sig.value = next;
}

export function clearSet(sig) {
  sig.value = new Set();
}

// ─── Persistence ─────────────────────────────────────
function storageKey() {
  return `review-${data.value?.meta?.url || data.value?.meta?.title || "local"}`;
}

export function loadReviewState() {
  try {
    const key = storageKey();
    const saved = localStorage.getItem(key);
    if (saved) reviewState.value = JSON.parse(saved);

    const collapseKey = `${key}:collapsed`;
    const savedCollapse = localStorage.getItem(collapseKey);
    if (savedCollapse) {
      const parsed = JSON.parse(savedCollapse);
      collapsedSections.value = new Set(parsed.sections || []);
      collapsedHunks.value = new Set(parsed.hunks || []);
      autoCollapseApplied = true;
    }
  } catch {
    /* ignore */
  }
}

export function saveReviewState() {
  try {
    const key = storageKey();
    localStorage.setItem(key, JSON.stringify(reviewState.value));

    const collapseKey = `${key}:collapsed`;
    localStorage.setItem(collapseKey, JSON.stringify({
      sections: [...collapsedSections.value],
      hunks: [...collapsedHunks.value],
    }));
  } catch {
    /* ignore */
  }
}

// Auto-persist viewMode and darkMode
effect(() => { localStorage.setItem("review-tool-view", viewMode.value); });
effect(() => { localStorage.setItem("review-tool-dark", String(darkMode.value)); });

// ─── Auto-collapse ───────────────────────────────────
export function applyAutoCollapse() {
  if (autoCollapseApplied || !data.value?.walkthrough?.sections) return;
  autoCollapseApplied = true;

  const next = new Set(collapsedHunks.value);
  for (const section of data.value.walkthrough.sections) {
    if (!section.hunks?.length) continue;

    const fileGroups = new Map();
    for (const hunk of section.hunks) {
      if (!fileGroups.has(hunk.file)) fileGroups.set(hunk.file, []);
      fileGroups.get(hunk.file).push(hunk);
    }

    for (const [filePath, fileHunks] of fileGroups) {
      const importanceOrder = { critical: 0, important: 1, supporting: 2, context: 3 };
      const topImportance = fileHunks.reduce((best, h) => {
        const hImp = h.importance || "important";
        return (importanceOrder[hImp] || 2) < (importanceOrder[best] || 2) ? hImp : best;
      }, fileHunks[0].importance || "important");

      if (topImportance === "supporting" || topImportance === "context") {
        next.add(`${section.id}:${filePath}`);
      }
    }
  }
  collapsedHunks.value = next;
}

// ─── Derived State ───────────────────────────────────
export function findFile(path) {
  const pf = parsedFiles.value;
  if (pf[path]) return pf[path];
  const stripped = path.replace(/^\//, "");
  if (pf[stripped]) return pf[stripped];
  for (const [key, file] of Object.entries(pf)) {
    if (key.endsWith(path) || path.endsWith(key)) return file;
  }
  return null;
}

export function getFileCoverage(wt) {
  const pf = parsedFiles.value;
  const allFiles = Object.keys(pf);

  const coveredSet = new Set();
  if (wt?.sections) {
    for (const section of wt.sections) {
      for (const hunk of section.hunks || []) {
        const found = findFile(hunk.file);
        if (found) {
          for (const key of allFiles) {
            if (pf[key] === found) {
              coveredSet.add(key);
              break;
            }
          }
        }
      }
    }
  }

  const covered = allFiles.filter((f) => coveredSet.has(f));
  const uncovered = allFiles.filter((f) => !coveredSet.has(f));

  const commentedFiles = new Set((data.value?.comments || []).map((c) => c.path));
  const orphanedCommentFiles = [...commentedFiles].filter(
    (f) => !coveredSet.has(f) && !allFiles.some((af) => af === f || af.endsWith(f) || f.endsWith(af))
  );

  return {
    total: allFiles.length,
    covered,
    uncovered,
    coveredCount: covered.length,
    uncoveredCount: uncovered.length,
    pct: allFiles.length ? Math.round((covered.length / allFiles.length) * 100) : 100,
    orphanedCommentFiles,
  };
}

export function getProgress() {
  const d = data.value;
  const rs = reviewState.value;
  const pf = parsedFiles.value;
  if (!d?.walkthrough?.sections) return { reviewed: 0, total: 0, pct: 0, hunksReviewed: 0, hunksTotal: 0 };
  const sectionIds = d.walkthrough.sections.map((s) => s.id);
  const coverage = getFileCoverage(d.walkthrough);
  if (coverage.uncovered.length > 0) sectionIds.push("__remaining");
  const total = sectionIds.length;
  const reviewed = sectionIds.filter((id) => rs[id]?.reviewed).length;

  let hunksTotal = 0;
  let hunksReviewed = 0;
  for (const s of d.walkthrough.sections) {
    const fileGroups = new Set((s.hunks || []).map((h) => h.file));
    for (const f of fileGroups) {
      hunksTotal++;
      if (rs[`hunk:${s.id}:${f}`]?.reviewed) hunksReviewed++;
    }
  }

  return { reviewed, total, pct: total ? Math.round((reviewed / total) * 100) : 0, hunksReviewed, hunksTotal };
}

export function getEstimatedReadTime(section) {
  let wordCount = 0;
  let codeLines = 0;

  if (section.narrative) wordCount += section.narrative.split(/\s+/).length;
  for (const c of section.callouts || []) {
    if (c.text) wordCount += c.text.split(/\s+/).length;
  }
  for (const hunk of section.hunks || []) {
    const file = findFile(hunk.file);
    if (file) {
      for (const block of file.blocks || []) {
        codeLines += block.lines?.length || 0;
      }
    }
    if (hunk.annotation) wordCount += hunk.annotation.split(/\s+/).length;
  }

  const minutes = wordCount / 200 + codeLines / 30;
  return Math.max(1, Math.round(minutes));
}

export function getCommentCountForSection(section) {
  const d = data.value;
  if (!d?.comments?.length || !section.hunks?.length) return 0;
  const sectionFiles = new Set(section.hunks.map((h) => h.file));
  return d.comments.filter((c) =>
    [...sectionFiles].some((f) => f === c.path || f.endsWith(c.path) || c.path.endsWith(f))
  ).length;
}

export function isGitHubPR() {
  const d = data.value;
  return d?.meta?.source === "github" && d?.meta?.owner && d?.meta?.repo && d?.meta?.number;
}

// Update review state immutably
export function setReviewed(key, checked) {
  reviewState.value = {
    ...reviewState.value,
    [key]: { reviewed: checked, timestamp: new Date().toISOString() },
  };
  saveReviewState();
}
