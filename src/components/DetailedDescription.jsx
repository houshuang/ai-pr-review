import { h } from "preact";
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { data } from "../state";
import { md } from "../utils";
import { walkthroughIdentity } from "../walkthrough-poll";

export const descriptionScope = signal(null);
export function DescriptionButton({
  scope = { kind: "pr" },
  label = "Generate detailed description",
}) {
  return (
    <button
      className="btn btn-sm description-button"
      onClick={(event) => {
        event.stopPropagation();
        descriptionScope.value = scope;
      }}
    >
      {label}
    </button>
  );
}

export function DetailedDescription() {
  const scope = descriptionScope.value;
  const identity = walkthroughIdentity(data.value);
  return scope ? (
    <DescriptionPanel
      key={`${identity}:${JSON.stringify(scope)}`}
      scope={scope}
      identity={identity}
    />
  ) : null;
}

function DescriptionPanel({ scope, identity }) {
  const [state, setState] = useState({ status: "loading" });
  const [source, setSource] = useState(null);
  const [question, setQuestion] = useState("");
  const [thread, setThread] = useState([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef();
  const sourceRef = useRef();
  const epoch = useRef(0);
  const closeButton = useRef();
  const requests = useRef(new Set());
  const scopeKey = JSON.stringify(scope);
  async function request(action, extra = {}) {
    const abort = new AbortController();
    requests.current.add(abort);
    try {
      const response = await fetch("/api/explanation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({
          slug: new URLSearchParams(window.location.search).get("pr") || "walkthrough-data",
          generationId: identity,
          scope,
          action,
          ...extra,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      return result;
    } finally {
      requests.current.delete(abort);
    }
  }
  useEffect(() => {
    epoch.current++;
    let stopped = false,
      timer;
    const previousFocus = document.activeElement;
    closeButton.current?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const poll = async (initial = false) => {
      try {
        let result = await request("load");
        if (initial && result.status === "idle") result = await request("generate");
        if (stopped) return;
        setState(result);
        if (result.status === "running") timer = setTimeout(() => poll(), 2000);
      } catch (err) {
        if (!stopped) setState({ status: "failed", error: err.message });
      }
    };
    poll(true);
    const keydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        descriptionScope.value = null;
      }
      if (event.key === "Tab") {
        const focusable = [
          ...dialog.current.querySelectorAll("button, textarea, input, a[href]"),
        ].filter((el) => !el.disabled);
        const first = focusable[0],
          last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      epoch.current++;
      stopped = true;
      clearTimeout(timer);
      requests.current.forEach((abort) => abort.abort());
      document.removeEventListener("keydown", keydown, true);
      document.body.style.overflow = originalOverflow;
      previousFocus?.focus();
    };
  }, [scopeKey, identity]);
  useEffect(() => {
    if (source && !source.loading)
      sourceRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [source]);
  const retry = async () => {
    try {
      await request("generate", { force: true });
      descriptionScope.value = { ...scope, retry: Date.now() };
    } catch (err) {
      setError(err.message);
    }
  };
  const cancel = async () => {
    try {
      await request("cancel");
      setState({ status: "failed", error: "Generation cancelled. You can retry." });
    } catch (err) {
      setError(err.message);
    }
  };
  const showSource = async (reference) => {
    const currentEpoch = epoch.current;
    setSource({ loading: true });
    try {
      const result = await request("source", { reference });
      if (currentEpoch === epoch.current) setSource(result);
    } catch (err) {
      if (currentEpoch === epoch.current && err.name !== "AbortError")
        setSource({ error: err.message });
    }
  };
  const ask = async (event) => {
    event.preventDefault();
    if (!question.trim() || asking) return;
    const currentEpoch = epoch.current;
    const message = question.trim();
    setQuestion("");
    setAsking(true);
    setError("");
    const history = [...thread, { role: "user", content: message }];
    setThread(history);
    try {
      const answer = await request("followup", { message, history });
      if (currentEpoch === epoch.current)
        setThread([
          ...history,
          { role: "assistant", content: answer.markdown, references: answer.references },
        ]);
    } catch (err) {
      if (currentEpoch === epoch.current && err.name !== "AbortError") setError(err.message);
    } finally {
      if (currentEpoch === epoch.current) setAsking(false);
    }
  };
  const references = (refs) =>
    !refs?.length ? null : (
      <details className="description-reference-list">
        <summary>View {refs.length} source references</summary>
        <div className="description-references">
          {refs?.map((ref, index) => (
            <button key={index} className="btn-link" onClick={() => showSource(ref)}>
              {ref.path}:{ref.line} · {ref.revision}
            </button>
          ))}
        </div>
      </details>
    );
  return (
    <div
      className="description-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) descriptionScope.value = null;
      }}
    >
      <div
        className="description-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="description-title"
        ref={dialog}
      >
        <header className="description-header">
          <div>
            <span className="section-number">Detailed description · {scope.kind}</span>
            <h2 id="description-title">
              {state.result?.title || scope.path || "Understand the design"}
            </h2>
          </div>
          <button
            className="btn"
            ref={closeButton}
            onClick={() => (descriptionScope.value = null)}
            aria-label="Close detailed description"
          >
            Close
          </button>
        </header>
        <div className="description-body">
          {["loading", "running"].includes(state.status) && (
            <div role="status">
              <p>Reading the reviewed code, its callers and tests…</p>
              <p>You can close this panel and return while generation continues.</p>
              {state.status === "running" && (
                <button className="btn" onClick={cancel}>
                  Cancel generation
                </button>
              )}
            </div>
          )}
          {state.status === "failed" && (
            <div role="alert">
              <p>{state.error}</p>
              <button className="btn" onClick={retry}>
                Retry generation
              </button>
            </div>
          )}
          {state.result && (
            <>
              <p className="description-provenance">
                {state.result.provenance} · Codex · Saved{" "}
                {new Date(state.result.generatedAt).toLocaleString()}
              </p>
              <article
                className="narrative"
                dangerouslySetInnerHTML={{ __html: md(state.result.markdown) }}
              />
              {references(state.result.references)}
              <button className="btn btn-sm" onClick={retry}>
                Regenerate description
              </button>
              {thread.map((item, index) => (
                <section key={index} className={`description-message ${item.role}`}>
                  <strong>{item.role === "user" ? "You" : "Codex"}</strong>
                  <div
                    className="narrative"
                    dangerouslySetInnerHTML={{ __html: md(item.content) }}
                  />
                  {references(item.references)}
                </section>
              ))}
              <form onSubmit={ask} className="description-question">
                <label htmlFor="description-question">Ask about this design</label>
                <textarea
                  id="description-question"
                  value={question}
                  onInput={(event) => setQuestion(event.target.value)}
                  placeholder="Why is this structure necessary? What would break with a simpler alternative?"
                />
                <button className="btn" disabled={asking || !question.trim()}>
                  {asking ? "Inspecting code…" : "Ask follow-up"}
                </button>
              </form>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          {source && (
            <section className="description-source" ref={sourceRef}>
              <button className="btn btn-sm" onClick={() => setSource(null)}>
                Close source
              </button>
              {source.loading ? (
                <p>Loading source…</p>
              ) : source.error ? (
                <p role="alert">{source.error}</p>
              ) : (
                <>
                  <h3>
                    {source.path} · {source.revision}
                  </h3>
                  <p>{source.provenance}</p>
                  <pre>
                    <code>{source.text}</code>
                  </pre>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
