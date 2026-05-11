import { useEffect, useRef } from "preact/hooks";
import { darkMode } from "./state";
import { sanitizeMermaidSource } from "./mermaid-sanitize.js";

let mermaidLoaded = false;
let mermaidLoading = null;
let currentThemeIsDark = null;

function getThemeVars(isDark) {
  if (isDark) {
    return {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: "12px",
      primaryColor: "rgba(122,173,224,0.15)",
      primaryTextColor: "#e0ddd5",
      primaryBorderColor: "#7aade0",
      lineColor: "#555",
      secondaryColor: "rgba(63,185,80,0.15)",
      tertiaryColor: "rgba(176,136,212,0.15)",
      background: "#222222",
      mainBkg: "#2a2a2a",
      nodeBorder: "#555",
      clusterBkg: "#2a2a2a",
      titleColor: "#e0ddd5",
      edgeLabelBackground: "#2a2a2a",
    };
  }
  return {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: "12px",
    primaryColor: "rgba(82,125,165,0.12)",
    primaryTextColor: "#37352f",
    primaryBorderColor: "#527da5",
    lineColor: "#b4b4b0",
    secondaryColor: "rgba(84,129,100,0.12)",
    tertiaryColor: "rgba(144,101,176,0.12)",
  };
}

async function loadMermaid() {
  if (mermaidLoaded) return;
  if (mermaidLoading) return mermaidLoading;

  mermaidLoading = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    script.onload = () => {
      const isDark = darkMode.value;
      window.mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "neutral",
        themeVariables: getThemeVars(isDark),
      });
      currentThemeIsDark = isDark;
      mermaidLoaded = true;
      resolve();
    };
    document.head.appendChild(script);
  });

  return mermaidLoading;
}

function reinitMermaid(isDark) {
  if (!mermaidLoaded || !window.mermaid) return;
  if (currentThemeIsDark === isDark) return;
  window.mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? "dark" : "neutral",
    themeVariables: getThemeVars(isDark),
  });
  currentThemeIsDark = isDark;
}

export async function renderMermaidIn(container) {
  if (!container) return;
  if (!mermaidLoaded) await loadMermaid();

  // Re-init if dark mode changed
  reinitMermaid(darkMode.value);

  installMermaidZoom();

  const els = container.querySelectorAll(".mermaid-source");
  for (const el of els) {
    const id = `mermaid-${Math.random().toString(36).slice(2, 8)}`;
    try {
      let raw = el.textContent.trim().replace(/^```(?:mermaid)?\s*\n?/, "").replace(/\n?```\s*$/, "");
      // Decode HTML entities that may have leaked through the rendering pipeline
      raw = raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

      // Validate syntax first; if it fails, sanitize and retry
      try {
        await window.mermaid.parse(raw);
      } catch {
        const fixed = sanitizeMermaidSource(raw);
        if (fixed !== raw) {
          console.info("Mermaid: auto-fixed diagram syntax");
          raw = fixed;
        }
      }

      const { svg } = await window.mermaid.render(id, raw);
      const div = document.createElement("div");
      div.className = "mermaid-rendered";
      div.innerHTML = svg;
      el.replaceWith(div);
    } catch (err) {
      console.warn("Mermaid render failed:", err);
      el.classList.add("mermaid-error");
      el.textContent = `Diagram error: ${err.message}\n\n${el.textContent}`;
    }
  }
}

export function useMermaid(ref) {
  useEffect(() => {
    if (ref.current) {
      renderMermaidIn(ref.current);
    }
  });
}

export function ensureMermaidLoaded() {
  loadMermaid();
}

// Click a rendered diagram → open it in a pan/zoom overlay.
// Idempotent: safe to call many times (e.g. after every render).
export function installMermaidZoom() {
  if (typeof window === "undefined" || window.__mermaidZoomInstalled) return;
  window.__mermaidZoomInstalled = true;

  document.addEventListener("click", (e) => {
    const target = e.target.closest(".mermaid-rendered");
    if (!target) return;
    // Don't hijack text selections
    const sel = window.getSelection?.();
    if (sel && sel.toString().length > 0) return;
    openMermaidOverlay(target);
  });
}

function openMermaidOverlay(sourceDiv) {
  const svg = sourceDiv.querySelector("svg");
  if (!svg) return;

  const overlay = document.createElement("div");
  overlay.className = "mermaid-zoom-overlay";
  overlay.innerHTML = `
    <div class="mermaid-zoom-backdrop"></div>
    <div class="mermaid-zoom-stage">
      <div class="mermaid-zoom-canvas"></div>
    </div>
    <div class="mermaid-zoom-hint">Scroll to zoom · Drag to pan · Double-click to reset · Esc to close</div>
    <div class="mermaid-zoom-controls">
      <button type="button" class="mermaid-zoom-btn" data-act="out" title="Zoom out (−)">−</button>
      <button type="button" class="mermaid-zoom-btn" data-act="reset" title="Reset (0)">⊙</button>
      <button type="button" class="mermaid-zoom-btn" data-act="in" title="Zoom in (+)">+</button>
      <button type="button" class="mermaid-zoom-btn mermaid-zoom-close" data-act="close" title="Close (Esc)">✕</button>
    </div>
  `;

  const canvas = overlay.querySelector(".mermaid-zoom-canvas");
  const clone = svg.cloneNode(true);
  clone.removeAttribute("style");
  // SVG's width="100%" collapses to 0 inside an auto-sized flex child.
  // Force explicit pixel dimensions from viewBox so it has intrinsic size.
  const vb = clone.getAttribute("viewBox");
  if (vb) {
    const parts = vb.split(/\s+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      clone.setAttribute("width", parts[2]);
      clone.setAttribute("height", parts[3]);
    }
  } else {
    const box = svg.getBoundingClientRect();
    if (box.width && box.height) {
      clone.setAttribute("width", box.width);
      clone.setAttribute("height", box.height);
    }
  }
  canvas.appendChild(clone);

  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const state = { scale: 1, tx: 0, ty: 0 };
  const MIN = 0.2, MAX = 8;
  const stage = overlay.querySelector(".mermaid-zoom-stage");

  const apply = () => {
    canvas.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
  };

  // Fit the SVG to the viewport on open
  requestAnimationFrame(() => {
    const box = clone.getBoundingClientRect();
    const margin = 80;
    const fit = Math.min(
      (window.innerWidth - margin) / Math.max(box.width, 1),
      (window.innerHeight - margin) / Math.max(box.height, 1),
      1.5
    );
    state.scale = Math.max(MIN, fit);
    apply();
    overlay.classList.add("is-open");
  });

  const zoomAt = (factor, cx, cy) => {
    const rect = stage.getBoundingClientRect();
    const x = cx - rect.left - rect.width / 2;
    const y = cy - rect.top - rect.height / 2;
    const next = Math.min(MAX, Math.max(MIN, state.scale * factor));
    const k = next / state.scale;
    state.tx = x - (x - state.tx) * k;
    state.ty = y - (y - state.ty) * k;
    state.scale = next;
    apply();
  };

  const reset = () => {
    state.scale = 1; state.tx = 0; state.ty = 0;
    // Re-fit
    const box = clone.getBoundingClientRect();
    const margin = 80;
    const fit = Math.min(
      (window.innerWidth - margin) / Math.max(box.width / state.scale, 1),
      (window.innerHeight - margin) / Math.max(box.height / state.scale, 1),
      1.5
    );
    state.scale = Math.max(MIN, fit);
    apply();
  };

  // Wheel: zoom anchored at cursor
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomAt(factor, e.clientX, e.clientY);
  }, { passive: false });

  // Drag to pan
  let drag = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".mermaid-zoom-controls")) return;
    drag = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("is-dragging");
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    state.tx = drag.tx + (e.clientX - drag.x);
    state.ty = drag.ty + (e.clientY - drag.y);
    apply();
  });
  const endDrag = () => { drag = null; stage.classList.remove("is-dragging"); };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  // Double-click to reset
  stage.addEventListener("dblclick", (e) => {
    if (e.target.closest(".mermaid-zoom-controls")) return;
    reset();
  });

  // Controls
  overlay.querySelector(".mermaid-zoom-controls").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    if (act === "in") zoomAt(1.25, cx, cy);
    else if (act === "out") zoomAt(1 / 1.25, cx, cy);
    else if (act === "reset") reset();
    else if (act === "close") close();
  });

  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "+" || e.key === "=") zoomAt(1.25, window.innerWidth / 2, window.innerHeight / 2);
    else if (e.key === "-") zoomAt(1 / 1.25, window.innerWidth / 2, window.innerHeight / 2);
    else if (e.key === "0") reset();
  };
  document.addEventListener("keydown", onKey);

  overlay.querySelector(".mermaid-zoom-backdrop").addEventListener("click", () => close());

  function close() {
    document.removeEventListener("keydown", onKey);
    document.body.style.overflow = "";
    overlay.classList.remove("is-open");
    setTimeout(() => overlay.remove(), 150);
  }
}
