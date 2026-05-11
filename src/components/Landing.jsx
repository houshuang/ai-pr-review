import { h } from "preact";
import { useState, useCallback } from "preact/hooks";
import { data, parsedFiles, loadReviewState, applyAutoCollapse, loadError } from "../state";
import { parseDiff } from "../diff";


function LoadErrorBanner({ error }) {
  const { slug, kind, message } = error;
  const url = `/walkthroughs/${slug}.json`;

  let title, body;
  if (kind === "stale-dev-server") {
    title = `Can't load "${slug}" — dev server is stale`;
    body = (
      <>
        <p>
          The server returned HTML instead of JSON for <code>{url}</code>. The file likely
          exists on disk, but Vite isn't serving it — new files added to <code>public/</code>{" "}
          after the dev server started aren't always picked up.
        </p>
        <p><strong>Fix:</strong> restart the dev server (stop and rerun <code>pnpm dev</code>), then reload this page.</p>
      </>
    );
  } else if (kind === "missing") {
    title = `Walkthrough "${slug}" not found`;
    body = (
      <p>
        No file at <code>{url}</code>. Generate it with{" "}
        <code>node src/generate.js &lt;PR URL&gt;</code> and then reload.
      </p>
    );
  } else if (kind === "parse") {
    title = `Walkthrough "${slug}" is not valid JSON`;
    body = <p>Parser error: <code>{message}</code>. The file may be truncated or corrupt.</p>;
  } else if (kind === "network") {
    title = `Network error loading "${slug}"`;
    body = <p><code>{message}</code> — is the dev server still running?</p>;
  } else {
    title = `Failed to load "${slug}"`;
    body = <p><code>{message}</code></p>;
  }

  return (
    <div className="load-error-banner">
      <h3>{title}</h3>
      {body}
    </div>
  );
}

export function Landing() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [showCli, setShowCli] = useState(false);
  const [cliUrl, setCliUrl] = useState("");

  const loadData = useCallback((json) => {
    data.value = json;
    parsedFiles.value = parseDiff(json.diff);
    loadReviewState();
    applyAutoCollapse();
  }, []);

  const handleFetchPR = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setCliUrl(trimmed);
    setShowCli(true);
  }, [url]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === "Enter") {
      const trimmed = e.target.value.trim();
      if (trimmed) {
        setCliUrl(trimmed);
        setShowCli(true);
      }
    }
  }, []);

  const handleLoadFile = useCallback(() => {
    const input = document.getElementById("file-input");
    const file = input?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target.result);
        loadData(json);
      } catch (err) {
        alert("Failed to parse JSON: " + err.message);
      }
    };
    reader.readAsText(file);
  }, [loadData]);

  const handleDemo = useCallback(async () => {
    try {
      const resp = await fetch("/walkthrough-data.json");
      if (resp.ok) {
        const json = await resp.json();
        loadData(json);
      } else {
        alert("No demo data found. Generate one first with:\n  node src/generate.js https://github.com/owner/repo/pull/123");
      }
    } catch {
      alert("No demo data found.");
    }
  }, [loadData]);

  if (showCli) {
    return (
      <div className="page-container">
        <div className="loading">
          <div className="loading-spinner"></div>
          <h2>Generate via CLI</h2>
          <p>Run this in your terminal, then reload:</p>
          <pre><code>node src/generate.js {cliUrl}</code></pre>
          <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="landing">
        {loadError.value && <LoadErrorBanner error={loadError.value} />}
        <div className="landing-header">
          <div className="kicker">Review Tool</div>
          <h1>Interactive PR Walkthrough</h1>
          <p className="subtitle">AI-narrated code review that structures your PR diff into a readable, reviewable narrative.</p>
        </div>

        <div className="landing-options">
          <div className="landing-card">
            <h3>GitHub PR</h3>
            <p>Enter a GitHub PR URL to generate an interactive walkthrough.</p>
            <div className="input-group">
              <input
                type="text"
                id="pr-url"
                placeholder="https://github.com/owner/repo/pull/123"
                value={url}
                onInput={(e) => setUrl(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <button id="btn-fetch-pr" className="btn btn-primary" onClick={handleFetchPR}>Generate</button>
            </div>
          </div>

          <div className="landing-card">
            <h3>Load Existing</h3>
            <p>Load a previously generated walkthrough JSON file.</p>
            <div className="input-group">
              <input type="file" id="file-input" accept=".json" />
              <button id="btn-load-file" className="btn" onClick={handleLoadFile}>Load</button>
            </div>
          </div>

          <div className="landing-card">
            <h3>Demo</h3>
            <p>Try with a sample walkthrough to see how the tool works.</p>
            <button id="btn-demo" className="btn" onClick={handleDemo}>Load Demo</button>
          </div>
        </div>

        <div className="landing-help">
          <h4>Quick Start</h4>
          <pre><code>node src/generate.js https://github.com/owner/repo/pull/123</code></pre>
          <p>Then refresh this page &mdash; the walkthrough loads automatically.</p>
        </div>
      </div>
    </div>
  );
}
