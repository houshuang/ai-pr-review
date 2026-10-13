import { h } from "preact";
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { data, isGitHubPR } from "../state";
import { changedPatchFiles, staleSectionFiles } from "../stale-sections.js";

// shape: null | {
//   currentSha, generatedSha, dismissed,
//   compare?: { rebased, commits: [{sha, message, author}], fileCount, additions, deletions },
//   changedFiles: null | [path]  (the PR's files whose own change differs from the walkthrough's diff)
// }
const staleState = signal(null);

// Per section id, the PR files whose change differs from what the section explains.
export const staleSections = signal({});

async function pullRequestFiles(owner, repo, number) {
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await ghApi(`repos/${owner}/${repo}/pulls/${number}/files`, { per_page: 100, page });
    if (!Array.isArray(batch)) throw new Error("Unexpected pull request file list");
    files.push(...batch);
    if (batch.length < 100) return files;
  }
  return files;
}

function ghApi(endpoint, data = {}) {
  return fetch("/api/gh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "GET", endpoint, data }),
  }).then((r) => r.json());
}

export function StaleBanner() {
  const d = data.value;
  const state = staleState.value;

  useEffect(() => {
    if (!d || !isGitHubPR() || !d.meta.headSha) return;
    const { owner, repo, number } = d.meta;
    const generatedSha = d.meta.headSha;
    staleSections.value = {};

    let cancelled = false;
    (async () => {
      try {
        const pr = await ghApi(`repos/${owner}/${repo}/pulls/${number}`);
        const currentSha = pr.head?.sha;
        if (cancelled || !currentSha || currentSha === generatedSha) return;

        let changedFiles = null;
        try {
          changedFiles = changedPatchFiles(d.diff, await pullRequestFiles(owner, repo, number));
          if (!cancelled) staleSections.value = staleSectionFiles(d.walkthrough, changedFiles);
        } catch {
          // Without the file list the banner still reports the new commits.
        }

        // Try to enrich with what actually changed. If this fails, fall back
        // to the bare "stale" message rather than swallowing the warning.
        let compare = null;
        try {
          const cmp = await ghApi(
            `repos/${owner}/${repo}/compare/${generatedSha}...${currentSha}`
          );
          if (cmp && Array.isArray(cmp.commits)) {
            const files = cmp.files || [];
            compare = {
              rebased: cmp.status === "diverged",
              commits: cmp.commits.map((c) => ({
                sha: (c.sha || "").slice(0, 7),
                message: (c.commit?.message || "").split("\n")[0],
                author:
                  c.author?.login || c.commit?.author?.name || "",
              })),
              fileCount: files.length,
              additions: files.reduce((s, f) => s + (f.additions || 0), 0),
              deletions: files.reduce((s, f) => s + (f.deletions || 0), 0),
            };
          }
        } catch {
          // ignore; show plain banner
        }

        if (!cancelled) {
          staleState.value = { currentSha, generatedSha, dismissed: false, compare, changedFiles };
        }
      } catch {
        // ignore network/auth failures
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [d]);

  if (!state || state.dismissed) return null;

  const shortOld = state.generatedSha.slice(0, 7);
  const shortNew = state.currentSha.slice(0, 7);
  const cmp = state.compare;
  const n = cmp?.commits.length || 0;

  return (
    <div className="stale-banner">
      <span className="stale-icon">&#x26A0;</span>
      <div className="stale-text">
        <div>
          <strong>Stale review</strong>
          {" — "}
          {cmp
            ? <>{n} new commit{n === 1 ? "" : "s"} since this walkthrough ({shortOld} &rarr; {shortNew}):</>
            : <>The PR has new commits since this walkthrough was generated ({shortOld} &rarr; {shortNew}). Re-run <code>review</code> to update.</>}
        </div>
        {cmp && (
          <ul className="stale-commit-list">
            {cmp.commits.map((c) => (
              <li key={c.sha}>
                <code>{c.sha}</code> {c.message}
                {c.author ? <span className="stale-author"> · {c.author}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {state.changedFiles && (
          <div className="stale-stats">
            {staleSummary(state.changedFiles.length, Object.keys(staleSections.value).length, cmp?.rebased)}
            {" "}Re-run <code>review</code> to update.
          </div>
        )}
        {!state.changedFiles && cmp && !cmp.rebased && (
          <div className="stale-stats">
            {cmp.fileCount} file{cmp.fileCount === 1 ? "" : "s"},{" "}
            <span className="stale-add">+{cmp.additions}</span>{" "}
            <span className="stale-del">&minus;{cmp.deletions}</span>
            . Re-run <code>review</code> to update.
          </div>
        )}
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

// A rebase's compare also counts the base branch's changes, so the summary counts only the PR's own files.
function staleSummary(files, sections, rebased) {
  const prefix = rebased ? "Rebased; " : "";
  if (!files) return `${prefix}the PR's own changes are the same as in this walkthrough.`;
  const fileText = `${files} file${files === 1 ? "" : "s"} of the PR changed`;
  const sectionText = sections ? `${sections} section${sections === 1 ? "" : "s"} marked below` : "no section cites them";
  return `${prefix}${fileText}; ${sectionText}.`;
}
