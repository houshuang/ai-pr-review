import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { data } from "../state";
import { walkthroughIdentity } from "../walkthrough-poll";

export function SourcePreview() {
  const review = data.value;
  const identity = walkthroughIdentity(review);
  return review ? <SourceSession key={identity} review={review} identity={identity} /> : null;
}

function SourceSession({ review, identity }) {
  const [popup, setPopup] = useState(null);
  const [source, setSource] = useState(null);
  const active = useRef(null);
  const panel = useRef(null);
  const controls = useRef(null);
  const epoch = useRef(0);
  const cache = useRef(new Map());
  const requests = useRef(new Set());
  const suppressFocus = useRef(null);
  const closing = useRef(null);
  const opening = useRef(null);

  async function load(reference, full) {
    const key = JSON.stringify({ ...reference, full });
    if (!cache.current.has(key)) {
      const abort = new AbortController();
      requests.current.add(abort);
      const pending = fetch("/api/explanation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({
          slug: new URLSearchParams(location.search).get("pr") || "walkthrough-data",
          generationId: identity,
          scope: { kind: "pr" },
          action: "source",
          reference: { ...reference, full },
        }),
      })
        .then(async (response) => {
          const value = await response.json();
          if (!response.ok) {
            throw new Error(value.error || "Source unavailable");
          }
          return value;
        })
        .catch((error) => {
          cache.current.delete(key);
          throw error;
        })
        .finally(() => requests.current.delete(abort));
      cache.current.set(key, pending);
    }
    return cache.current.get(key);
  }
  function close(restoreFocus = false) {
    clearTimeout(opening.current);
    clearTimeout(closing.current);
    epoch.current++;
    const anchor = active.current?.anchor;
    active.current = null;
    setPopup(null);
    setSource(null);
    if (restoreFocus && anchor?.isConnected) {
      suppressFocus.current = anchor;
      anchor.focus();
    }
  }
  async function show(anchor, full = false, pinned = false) {
    clearTimeout(opening.current);
    clearTimeout(closing.current);
    const reference = {
      path: anchor.dataset.fileRef,
      line: Number(anchor.dataset.line),
      revision: anchor.dataset.revision || "head",
    };
    const endLine = Number(anchor.dataset.endLine) || reference.line;
    const token = ++epoch.current;
    active.current = { anchor, pinned, full };
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(760, window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 20;
    const above = rect.top - 20;
    const height = Math.min(420, Math.max(120, below, above));
    setPopup({
      reference,
      endLine,
      full,
      pinned,
      width,
      height,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      top: below >= above ? rect.bottom + 8 : Math.max(12, rect.top - height - 8),
    });
    setSource({ loading: true });
    try {
      const value = await load(reference, full);
      if (token === epoch.current) {
        setSource(value);
      }
    } catch (error) {
      if (token === epoch.current && error.name !== "AbortError") {
        setSource({ error: error.message });
      }
    }
  }
  useEffect(() => {
    const inside = (target) => panel.current?.contains(target);
    const leave = () => {
      clearTimeout(opening.current);
      if (!active.current?.pinned && !active.current?.full) {
        closing.current = setTimeout(() => close(), 240);
      }
    };
    const enter = (event) => {
      if (inside(event.target)) {
        clearTimeout(closing.current);
        return;
      }
      const anchor = event.target.closest?.(".file-ref-link");
      if (!anchor) {
        leave();
        return;
      }
      clearTimeout(closing.current);
      if (active.current?.full || active.current?.pinned || active.current?.anchor === anchor) {
        return;
      }
      clearTimeout(opening.current);
      if (event.type === "focusin") {
        if (suppressFocus.current === anchor) {
          suppressFocus.current = null;
          return;
        }
        show(anchor);
      } else {
        opening.current = setTimeout(() => show(anchor), 180);
      }
    };
    const exit = (event) => {
      if (
        inside(event.relatedTarget) ||
        event.relatedTarget?.closest?.(".file-ref-link") === active.current?.anchor
      ) {
        return;
      }
      leave();
    };
    const click = (event) => {
      const anchor = event.target.closest?.(".file-ref-link");
      if (anchor) {
        event.preventDefault();
        show(anchor, false, true);
      }
    };
    const keydown = (event) => {
      if (!active.current) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(true);
      }
      if (active.current.full && event.key === "Tab") {
        const buttons = [...panel.current.querySelectorAll('button,a[href],[tabindex="0"]')];
        const first = buttons[0],
          last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const reposition = (event) => {
      if (!active.current?.full && !inside(event.target)) {
        close();
      }
    };
    document.addEventListener("pointerover", enter);
    document.addEventListener("pointerout", exit);
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", exit);
    document.addEventListener("click", click);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      epoch.current++;
      clearTimeout(opening.current);
      clearTimeout(closing.current);
      requests.current.forEach((abort) => abort.abort());
      document.removeEventListener("pointerover", enter);
      document.removeEventListener("pointerout", exit);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", exit);
      document.removeEventListener("click", click);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [identity]);
  useEffect(() => {
    if (source?.text) {
      panel.current?.querySelector(".source-code-line.cited")?.scrollIntoView({ block: "center" });
    }
  }, [source]);
  useEffect(() => {
    if (popup?.full || popup?.pinned) {
      controls.current?.focus();
    }
  }, [popup?.full, popup?.pinned]);
  useEffect(() => {
    if (!popup?.full) {
      return;
    }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [popup?.full]);
  if (!popup) {
    return null;
  }
  const { reference, full } = popup;
  const sha =
    source?.provenance?.match(/^committed snapshot ([a-f0-9]{40,64})$/)?.[1] ||
    (reference.revision === "head" ? review.meta.headSha : review.meta.diffBaseSha);
  const actualPath = source?.path || reference.path;
  const github =
    review.meta.owner && review.meta.repo && sha
      ? `https://github.com/${encodeURIComponent(review.meta.owner)}/${encodeURIComponent(review.meta.repo)}/blob/${sha}/${actualPath.split("/").map(encodeURIComponent).join("/")}#L${reference.line}${popup.endLine !== reference.line ? `-L${popup.endLine}` : ""}`
      : null;
  return (
    <div
      className={full ? "source-viewer-overlay" : "source-preview-container"}
      onClick={(event) => {
        if (full && event.target === event.currentTarget) {
          close(true);
        }
      }}
    >
      <section
        ref={panel}
        className={`source-preview ${full ? "source-viewer" : ""}`}
        role={full ? "dialog" : "region"}
        aria-modal={full ? "true" : undefined}
        aria-label={`${reference.revision} source ${reference.path}`}
        style={
          full
            ? undefined
            : { width: popup.width, left: popup.left, top: popup.top, maxHeight: popup.height }
        }
      >
        <header>
          <div>
            <strong>
              {reference.path.split("/").pop()}:{reference.line}
              {popup.endLine !== reference.line ? `–${popup.endLine}` : ""}
            </strong>
            <span className="source-revision-badge">
              {reference.revision === "base" ? "base" : "updated"}
            </span>
            <div className="source-full-path">{actualPath}</div>
          </div>
          <button
            ref={controls}
            className="btn btn-sm"
            onClick={() => close(true)}
            aria-label="Close source preview"
          >
            Close
          </button>
        </header>
        {source?.loading ? (
          <p role="status">Loading recorded source…</p>
        ) : source?.error ? (
          <p role="alert">{source.error}</p>
        ) : (
          <div className="source-code" tabIndex="0">
            {source?.text?.split("\n").map((row) => {
              const match = row.match(/^(\d+): ?(.*)$/);
              const number = Number(match?.[1]);
              return (
                <div
                  key={number}
                  className={`source-code-line ${number >= reference.line && number <= popup.endLine ? "cited" : ""}`}
                >
                  <span className="source-line-number">{number}</span>
                  <code>{match?.[2] || " "}</code>
                </div>
              );
            })}
          </div>
        )}
        <footer>
          <span>
            {reference.revision === "base" ? "Base revision" : "Reviewed revision"}{" "}
            {source?.loading
              ? " · loading…"
              : sha?.slice(0, 7) ||
                (source?.provenance ? " · reconstructed patch" : " · unavailable")}
          </span>
          <div>
            {!full && (
              <button
                className="btn btn-sm"
                onClick={() => show(active.current.anchor, true, true)}
              >
                Jump to code
              </button>
            )}
            {github && (
              <a className="btn btn-sm" href={github} target="_blank" rel="noreferrer">
                Open on GitHub ↗
              </a>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
