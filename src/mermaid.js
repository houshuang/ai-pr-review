import { useEffect, useRef } from "preact/hooks";

let mermaidLoaded = false;
let mermaidLoading = null;

async function loadMermaid() {
  if (mermaidLoaded) return;
  if (mermaidLoading) return mermaidLoading;

  mermaidLoading = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    script.onload = () => {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: "neutral",
        themeVariables: {
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "12px",
          primaryColor: "rgba(82,125,165,0.12)",
          primaryTextColor: "#37352f",
          primaryBorderColor: "#527da5",
          lineColor: "#b4b4b0",
          secondaryColor: "rgba(84,129,100,0.12)",
          tertiaryColor: "rgba(144,101,176,0.12)",
        },
      });
      mermaidLoaded = true;
      resolve();
    };
    document.head.appendChild(script);
  });

  return mermaidLoading;
}

export async function renderMermaidIn(container) {
  if (!container) return;
  if (!mermaidLoaded) await loadMermaid();
  const els = container.querySelectorAll(".mermaid-source");
  for (const el of els) {
    const id = `mermaid-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const raw = el.textContent.trim().replace(/^```(?:mermaid)?\s*\n?/, "").replace(/\n?```\s*$/, "");
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
