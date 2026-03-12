import { h } from "preact";

export function CoverageBar({ coverage }) {
  if (coverage.total === 0) return null;

  return (
    <div className="coverage-bar">
      <div className="coverage-indicator">
        <span className="coverage-label">{coverage.coveredCount}/{coverage.total} files narrated</span>
        {coverage.uncoveredCount > 0 ? (
          <span className="coverage-remaining">{coverage.uncoveredCount} in Remaining Changes below</span>
        ) : (
          <span className="coverage-complete">All files covered in walkthrough</span>
        )}
      </div>
    </div>
  );
}
