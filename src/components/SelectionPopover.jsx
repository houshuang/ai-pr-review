import { h } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import { chatOpen, chatSelectedText } from "./ChatThread";

export function SelectionPopover() {
  const [pos, setPos] = useState(null);
  const [text, setText] = useState("");
  const popRef = useRef(null);

  useEffect(() => {
    function handleSelectionChange() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim().length < 3) {
        // Small delay before hiding — prevents flicker on click
        setTimeout(() => {
          const s = window.getSelection();
          if (!s || s.isCollapsed || s.toString().trim().length < 3) {
            setPos(null);
          }
        }, 150);
        return;
      }

      const selText = sel.toString().trim();
      // Only show for selections within diff/code areas
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer?.parentElement;
      if (!container) return;
      const inDiff = container.closest(".d2h-wrapper, .hunk-group, pre, code, .section-narrative");
      if (!inDiff) return;

      const rect = range.getBoundingClientRect();
      setText(selText);
      setPos({
        top: rect.top + window.scrollY - 36,
        left: rect.left + window.scrollX + rect.width / 2,
      });
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

  function handleClick() {
    chatSelectedText.value = text;
    chatOpen.value = true;
    setPos(null);
    window.getSelection()?.removeAllRanges();
  }

  if (!pos) return null;

  return (
    <div
      ref={popRef}
      class="selection-popover"
      style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button class="selection-popover-btn" onClick={handleClick}>
        Ask AI
      </button>
    </div>
  );
}
