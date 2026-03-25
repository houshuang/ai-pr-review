import { h } from "preact";
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { data, isGitHubPR } from "../state";

const staleState = signal(null); // null | { currentSha, generatedSha, dismissed }

export function StaleBanner() {
  const d = data.value;
  const state = staleState.value;

  useEffect(() => {
    if (!d || !isGitHubPR() || !d.meta.headSha) return;

    const { owner, repo, number } = d.meta;
    fetch("/api/gh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "GET",
        endpoint: `repos/${owner}/${repo}/pulls/${number}`,
        data: {},
      }),
    })
      .then((r) => r.json())
      .then((pr) => {
        const currentSha = pr.head?.sha;
        if (currentSha && currentSha !== d.meta.headSha) {
          staleState.value = { currentSha, generatedSha: d.meta.headSha, dismissed: false };
        }
      })
      .catch(() => {});
  }, [d]);

  if (!state || state.dismissed) return null;

  const shortOld = state.generatedSha.slice(0, 7);
  const shortNew = state.currentSha.slice(0, 7);

  return (
    <div className="stale-banner">
      <span className="stale-icon">&#x26A0;</span>
      <div className="stale-text">
        <strong>Stale review</strong> — The PR has new commits since this walkthrough was generated
        ({shortOld} &rarr; {shortNew}).
        Re-run <code>review</code> to update.
      </div>
      <button
        className="btn btn-sm stale-dismiss"
        onClick={() => { staleState.value = { ...state, dismissed: true }; }}
      >
        Dismiss
      </button>
    </div>
  );
}
