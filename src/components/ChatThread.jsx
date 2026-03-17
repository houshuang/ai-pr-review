import { h } from "preact";
import { useState, useRef, useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { data, currentSectionIndex } from "../state";
import { md } from "../utils";

// ── Chat state (signals) ──────────────────────
export const chatOpen = signal(false);
export const chatMessages = signal([]); // [{id, role, content, sectionId, timestamp}]

export function toggleChat() {
  chatOpen.value = !chatOpen.value;
}

// ── Component ─────────────────────────────────
export function ChatThread() {
  const [input, setInput] = useState("");
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

  // Focus input when opened
  useEffect(() => {
    if (chatOpen.value && inputRef.current) {
      setTimeout(() => inputRef.current.focus(), 50);
    }
  }, [chatOpen.value, sectionId]);

  async function sendMessage() {
    if (!input.trim() || streaming) return;

    const msg = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: input.trim(),
      sectionId,
      timestamp: new Date().toISOString(),
    };

    chatMessages.value = [...chatMessages.value, msg];
    setInput("");
    setStreaming(true);
    setStreamContent("");

    try {
      // Build thread history for context
      const history = chatMessages.value
        .filter(m => m.sectionId === sectionId)
        .slice(-20)
        .map(m => ({ role: m.role, content: m.content }));

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg.content,
          history,
          sectionId,
          sectionTitle: currentSection?.title,
          sectionNarrative: currentSection?.narrative,
          sectionFiles: (currentSection?.hunks || []).map(h => h.file),
          prTitle: d?.walkthrough?.title,
          prUrl: d?.meta?.url,
          prOverview: d?.walkthrough?.overview,
          projectPath: d?.meta?.projectPath || null,
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

  return (
    <div class="chat-thread">
      <div class="chat-thread-header">
        <div class="chat-thread-header-left">
          <div class="chat-thread-icon">C</div>
          <div>
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
        {sectionId && (
          <span class="chat-ctx-chip chat-ctx-section">{currentSection?.title}</span>
        )}
        {d?.meta?.url && <span class="chat-ctx-chip chat-ctx-pr">PR</span>}
        <span class="chat-ctx-chip chat-ctx-repo">Repo</span>
        <span class="chat-ctx-chip chat-ctx-tools">Tools</span>
      </div>

      <div class="chat-thread-messages" ref={messagesRef}>
        {threadMessages.length === 0 && !streaming && (
          <div class="chat-thread-empty">
            <div class="chat-thread-empty-text">
              Ask about this section's code changes, design decisions, or implications
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
              dangerouslySetInnerHTML={{ __html: renderContent(msg.content, msg.role) }}
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
              dangerouslySetInnerHTML={{ __html: renderContent(streamContent, "assistant") }}
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
            placeholder="Ask about this section..."
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
          <span>{currentSection?.title || ""}</span>
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

function renderContent(content, role) {
  if (role === "assistant") return md(content);
  return content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}
