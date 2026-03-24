import { h } from "preact";
import { useState, useRef, useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { data, currentSectionIndex } from "../state";
import { md } from "../utils";

// ── Chat state (signals) ──────────────────────
export const chatOpen = signal(false);
export const chatMessages = signal([]); // [{id, role, content, sectionId, timestamp}]
export const chatSelectedText = signal(""); // text selected when chat was opened

export function toggleChat() {
  // Capture selected text and detect section before opening
  if (!chatOpen.value) {
    const sel = window.getSelection();
    chatSelectedText.value = sel ? sel.toString().trim() : "";

    // Detect which section the selection or viewport is in
    const sections = data.value?.walkthrough?.sections || [];
    if (sections.length > 0) {
      // Try from selection context first
      let foundIdx = -1;
      if (sel && !sel.isCollapsed) {
        const el = sel.anchorNode?.parentElement?.closest?.(".review-section, [data-split-section]");
        if (el) {
          const id = el.id?.replace("section-", "") || el.dataset?.splitSection;
          foundIdx = sections.findIndex(s => s.id === id);
        }
      }
      // Fall back to topmost visible section
      if (foundIdx < 0) {
        const allSections = document.querySelectorAll(".review-section");
        for (const el of allSections) {
          const rect = el.getBoundingClientRect();
          if (rect.top < window.innerHeight / 2 && rect.bottom > 0) {
            const id = el.id?.replace("section-", "");
            const idx = sections.findIndex(s => s.id === id);
            if (idx >= 0) foundIdx = idx;
          }
        }
      }
      if (foundIdx >= 0) currentSectionIndex.value = foundIdx;
    }
  }
  chatOpen.value = !chatOpen.value;
}

// ── Component ─────────────────────────────────
export function ChatThread() {
  const [input, setInput] = useState("");
  const [quotedCode, setQuotedCode] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const messagesRef = useRef(null);
  const inputRef = useRef(null);

  const d = data.value;
  const sections = d?.walkthrough?.sections || [];
  const currentSection = sections[currentSectionIndex.value] || null;
  const sectionId = currentSection?.id || null;

  // Messages for current section
  const threadMessages = chatMessages.value.filter(m => m.sectionId === sectionId);

  // Auto-scroll
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [threadMessages.length, streamContent]);

  // Focus input when opened, capture selected text as quoted block
  useEffect(() => {
    if (chatOpen.value && inputRef.current) {
      setTimeout(() => {
        if (chatSelectedText.value) {
          setQuotedCode(chatSelectedText.value);
          chatSelectedText.value = "";
        }
        inputRef.current.focus();
      }, 50);
    }
  }, [chatOpen.value, sectionId]);

  // Build rich context from section data
  function buildSectionContext() {
    if (!currentSection) return {};
    const hunks = (currentSection.hunks || []).map(h => ({
      file: h.file,
      lines: `${h.startLine}-${h.endLine}`,
      importance: h.importance,
      annotation: h.annotation,
    }));
    const callouts = (currentSection.callouts || []).map(c => `[${c.type}] ${c.label}: ${c.text}`);
    return {
      sectionTitle: currentSection.title,
      sectionNarrative: currentSection.narrative,
      sectionHunks: hunks,
      sectionCallouts: callouts,
      sectionDiagram: currentSection.diagram || null,
    };
  }

  async function sendMessage() {
    if (!input.trim() || streaming) return;

    // Build the full message: quoted code (if any) + user's question
    const userText = input.trim();
    const fullContent = quotedCode
      ? `Regarding this code:\n\`\`\`\n${quotedCode}\n\`\`\`\n\n${userText}`
      : userText;

    const msg = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: fullContent,
      sectionId,
      timestamp: new Date().toISOString(),
    };

    chatMessages.value = [...chatMessages.value, msg];
    setInput("");
    setQuotedCode("");
    setStreaming(true);
    setStreamContent("");

    try {
      // Build thread history for context
      const history = chatMessages.value
        .filter(m => m.sectionId === sectionId)
        .slice(-20)
        .map(m => ({ role: m.role, content: m.content }));

      const sectionCtx = buildSectionContext();

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg.content,
          history,
          sectionId,
          ...sectionCtx,
          prTitle: d?.walkthrough?.title,
          prUrl: d?.meta?.url,
          prOverview: d?.walkthrough?.overview,
        }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullContent += decoder.decode(value, { stream: true });
        setStreamContent(fullContent);
      }

      if (fullContent.trim()) {
        chatMessages.value = [...chatMessages.value, {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content: fullContent.trim(),
          sectionId,
          timestamp: new Date().toISOString(),
        }];
      }
    } catch (err) {
      chatMessages.value = [...chatMessages.value, {
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: `*Error: ${err.message}*`,
        sectionId,
        timestamp: new Date().toISOString(),
      }];
    }

    setStreaming(false);
    setStreamContent("");
  }

  function handleInputResize(e) {
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  }

  if (!chatOpen.value) return null;

  const hunkCount = currentSection?.hunks?.length || 0;
  const fileCount = new Set((currentSection?.hunks || []).map(h => h.file)).size;

  return (
    <div class="chat-thread">
      <div class="chat-thread-header">
        <div class="chat-thread-header-left">
          <div class="chat-thread-icon">C</div>
          <div style="min-width:0">
            <div class="chat-thread-title">{currentSection?.title || "Thread"}</div>
            <div class="chat-thread-subtitle">
              {sectionId ? `Section ${currentSectionIndex.value + 1}` : "Select a section"}
            </div>
          </div>
        </div>
        <button class="chat-thread-close" onClick={() => (chatOpen.value = false)}>
          &times;
        </button>
      </div>

      <div class="chat-thread-context">
        <span class="chat-ctx-chip chat-ctx-section">{fileCount} file{fileCount !== 1 ? "s" : ""}, {hunkCount} hunk{hunkCount !== 1 ? "s" : ""}</span>
        {d?.walkthrough?.overview && <span class="chat-ctx-chip chat-ctx-pr">Overview</span>}
        {currentSection?.narrative && <span class="chat-ctx-chip chat-ctx-repo">Narrative</span>}
        {currentSection?.callouts?.length > 0 && <span class="chat-ctx-chip chat-ctx-tools">Callouts</span>}
      </div>

      <div class="chat-thread-messages" ref={messagesRef}>
        {threadMessages.length === 0 && !streaming && (
          <div class="chat-thread-empty">
            <div class="chat-thread-empty-text">
              Ask about this section's code changes, design decisions, or implications.
              {" "}Select text in the diff and press <kbd>a</kbd> to quote it here.
            </div>
          </div>
        )}

        {threadMessages.map((msg) => (
          <div class={`chat-msg chat-msg-${msg.role}`} key={msg.id}>
            <div class="chat-msg-header">
              <div class={`chat-msg-avatar chat-msg-avatar-${msg.role}`}>
                {msg.role === "user" ? "Y" : "C"}
              </div>
              <span class="chat-msg-name">{msg.role === "user" ? "You" : "Claude"}</span>
              <span class="chat-msg-time">{formatTime(msg.timestamp)}</span>
            </div>
            <div
              class="chat-msg-body"
              dangerouslySetInnerHTML={{ __html: md(msg.content) }}
            />
          </div>
        ))}

        {streaming && streamContent && (
          <div class="chat-msg chat-msg-assistant chat-msg-streaming">
            <div class="chat-msg-header">
              <div class="chat-msg-avatar chat-msg-avatar-assistant">C</div>
              <span class="chat-msg-name">Claude</span>
              <span class="chat-msg-time">streaming&hellip;</span>
            </div>
            <div
              class="chat-msg-body"
              dangerouslySetInnerHTML={{ __html: md(streamContent) }}
            />
          </div>
        )}

        {streaming && !streamContent && (
          <div class="chat-typing">
            <span class="chat-typing-dot" />
            <span class="chat-typing-dot" />
            <span class="chat-typing-dot" />
          </div>
        )}
      </div>

      <div class="chat-thread-input-area">
        {quotedCode && (
          <div class="chat-quoted-code">
            <pre>{quotedCode}</pre>
            <button class="chat-quoted-dismiss" onClick={() => setQuotedCode("")}>&times;</button>
          </div>
        )}
        <div class="chat-thread-input-row">
          <textarea
            ref={inputRef}
            class="chat-thread-input"
            value={input}
            onInput={(e) => {
              setInput(e.target.value);
              handleInputResize(e);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            onFocus={() => (window.__chatInputActive = true)}
            onBlur={() => (window.__chatInputActive = false)}
            placeholder={quotedCode ? "Ask about this code..." : "Ask about this section..."}
            rows="1"
          />
          <button
            class="chat-thread-send"
            onClick={sendMessage}
            disabled={streaming || !input.trim()}
          >
            &uarr;
          </button>
        </div>
        <div class="chat-thread-input-hint">
          <span>
            <kbd>Enter</kbd> send &middot; <kbd>Shift+Enter</kbd> newline
          </span>
        </div>
      </div>
    </div>
  );
}

function formatTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

