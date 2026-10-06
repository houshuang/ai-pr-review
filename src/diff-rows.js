// diff2html renders side-by-side as two separate tables, so once long lines
// wrap, a row on one side can grow taller than its partner on the other. Give
// each left/right row pair the height of the taller one.
//
// Self-contained (no imports, no closures) so export-static.js can inline it
// into the static page via Function.prototype.toString.
export function syncSideBySideRows(root) {
  const pairs = [];
  root.querySelectorAll(".d2h-files-diff").forEach((filesDiff) => {
    const bodies = filesDiff.querySelectorAll(".d2h-file-side-diff tbody");
    if (bodies.length !== 2) return;
    const left = Array.from(bodies[0].rows);
    const right = Array.from(bodies[1].rows);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      pairs.push([left[i], right[i]]);
    }
  });

  // Reset everything, then read every height, then write: one layout pass
  // instead of one per row.
  const spacer = (row) => row.querySelector(".annotation-sbs-spacer");
  for (const [l, r] of pairs) {
    l.style.height = r.style.height = "";
    const s = spacer(l) || spacer(r);
    if (s) s.style.minHeight = "";
  }
  const heights = pairs.map(([l, r]) => [l.getBoundingClientRect().height, r.getBoundingClientRect().height]);
  pairs.forEach(([l, r], i) => {
    const [lh, rh] = heights[i];
    if (Math.abs(lh - rh) < 0.5) return;
    const h = Math.max(lh, rh);
    l.style.height = r.style.height = `${h}px`;
    // An annotation spacer's inner div carries the background, so it must
    // grow with the row rather than leave a gap below it.
    const s = spacer(l) || spacer(r);
    if (s) s.style.minHeight = `${h}px`;
  });
}

// Re-sync whenever the container's width changes (window resize, sidebar
// toggle, a collapsed file being expanded). Height changes are ignored so the
// sync's own writes don't retrigger it.
export function observeSideBySideRows(root) {
  if (!root.querySelector(".d2h-file-side-diff") || typeof ResizeObserver === "undefined") return () => {};
  let lastWidth = -1;
  const observer = new ResizeObserver((entries) => {
    const width = entries[entries.length - 1].contentRect.width;
    if (width === lastWidth || width === 0) return;
    lastWidth = width;
    syncSideBySideRows(root);
  });
  observer.observe(root);
  return () => observer.disconnect();
}
