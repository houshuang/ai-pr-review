import { h } from "preact";
import { viewMode } from "../state";

const views = [
  ["editorial", "Editorial"],
  ["sidebar", "Sidebar"],
  ["focus", "Focus"],
  ["split", "Split"],
  ["developer", "Dev"],
  ["dashboard", "Dashboard"],
];

export function ViewSwitcher() {
  const current = viewMode.value;

  const handleClick = (id) => {
    viewMode.value = id;
  };

  return (
    <div className="toolbar-group view-switcher">
      {views.map(([id, label]) => (
        <button
          key={id}
          className={`btn btn-sm ${current === id ? "active" : ""}`}
          data-view={id}
          onClick={() => handleClick(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
