import { h } from "preact";
import { useCallback } from "preact/hooks";
import { actionPanelOpen } from "../state";

export function ActionPanel({ items }) {
  const isOpen = actionPanelOpen.value;

  const handleBackdropClick = useCallback(() => {
    actionPanelOpen.value = false;
  }, []);

  const handleItemClick = useCallback((item) => {
    if (item.action) item.action();
  }, []);

  // Group items by group
  const byGroup = new Map();
  for (const item of items) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group).push(item);
  }

  return (
    <>
      <div
        className={`action-panel-backdrop ${isOpen ? "open" : ""}`}
        id="action-panel-backdrop"
        onClick={handleBackdropClick}
      />
      <div className={`action-panel ${isOpen ? "open" : ""}`} id="action-panel">
        <div className="action-panel-inner">
          {[...byGroup.entries()].map(([group, groupItems]) => (
            <div key={group} className="action-panel-group">
              <div className="action-panel-group-label">{group}</div>
              {groupItems.map((item) => (
                <div
                  key={item.key}
                  className="action-panel-item"
                  data-action-key={item.key || ""}
                  onClick={() => handleItemClick(item)}
                >
                  <kbd>{item.key}</kbd>
                  <span className={`action-panel-item-label ${item.active ? "active-state" : ""}`}>{item.label}</span>
                  {item.active && <span className="action-panel-item-check">&#x2713;</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
