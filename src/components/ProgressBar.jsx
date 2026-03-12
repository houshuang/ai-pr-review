import { h } from "preact";

export function ProgressBar({ progress }) {
  return (
    <div className="progress-bar-container">
      <div className="progress-bar" style={{ width: `${progress.pct}%` }}></div>
      <span className="progress-label">{progress.pct}% reviewed</span>
    </div>
  );
}
