import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { getTaskConfig } from "./models.js";

const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;
const CLAUDE_RETRY_DELAYS_MS = [15_000, 45_000, 90_000];
const CLAUDE_TRANSIENT_FAILURE = /429|529|too many requests|rate.?limit|overloaded|503|service unavailable|capacity/i;
const CLAUDE_SETUP_FAILURE = /not logged in|please run \/login|invalid api key|authentication|unknown option|model .* not (?:found|available)|\b401\b/i;
// Tasks that read the repository get file tools. Claude Code has no
// equivalent of Codex's write sandbox, so investigation stays read-only too.
const REPOSITORY_TASKS = new Set(["investigation", "research", "explanation"]);
const READ_TOOLS = "Read,Grep,Glob";

function claudeFailure(detail, code) {
  const text = String(detail || `Claude Code exited with code ${code}`).trim().slice(0, 400);
  const err = new Error(`Claude Code failed: ${text}${/not logged in|\/login|\b401\b/i.test(text) ? " — run `claude` and log in" : ""}`);
  err.codexSetupFailure = CLAUDE_SETUP_FAILURE.test(text);
  err.codexTransient = !err.codexSetupFailure && CLAUDE_TRANSIENT_FAILURE.test(text);
  return err;
}

/** Reads `claude -p --output-format stream-json` events into text, activity and the final result. */
export function claudeEventReader(onText, onActivity) {
  let result = null;
  return {
    accept(line) {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "result") { result = event; return; }
      const content = event.message?.content;
      if (event.type === "assistant" && Array.isArray(content) && content.some((block) => block.type === "tool_use")) {
        onActivity?.({ type: "command-started" });
      } else if (event.type === "user" && Array.isArray(content) && content.some((block) => block.type === "tool_result")) {
        onActivity?.({ type: "command-completed" });
      } else {
        onActivity?.({ type: "activity" });
      }
      const delta = event.type === "stream_event" && event.event?.type === "content_block_delta" ? event.event.delta : null;
      if (delta?.type === "text_delta" && delta.text) onText?.(delta.text);
    },
    result: () => result,
  };
}

/** Same contract as runCodex, run through the Claude Code CLI with user settings and CLAUDE.md excluded. */
export async function runClaude({ retryDelaysMs = CLAUDE_RETRY_DELAYS_MS, onRetry, ...options }) {
  const deadline = Date.now() + (options.timeoutMs ?? CLAUDE_TIMEOUT_MS);
  let streamed = false;
  const onText = options.onText && ((...args) => { streamed = true; return options.onText(...args); });
  for (let attempt = 0; ; attempt++) {
    try {
      return await runClaudeOnce({ ...options, onText, timeoutMs: Math.max(1, deadline - Date.now()) });
    } catch (err) {
      const delay = retryDelaysMs[attempt];
      if (!err.codexTransient || streamed || delay === undefined || Date.now() + delay >= deadline || options.signal?.aborted) throw err;
      onRetry?.({ attempt: attempt + 1, delayMs: delay, error: err });
      await new Promise((resolvePromise, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error("Claude Code run aborted")); };
        const timer = setTimeout(() => { options.signal?.removeEventListener("abort", abort); resolvePromise(); }, delay);
        options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
}

async function runClaudeOnce({
  systemPrompt,
  userPrompt,
  cwd = process.cwd(),
  task = "generation",
  model,
  effort,
  allowShell = false,
  readableDirs = [],
  outputSchema,
  onText,
  onActivity,
  onUsage,
  signal,
  timeoutMs = CLAUDE_TIMEOUT_MS,
  killGraceMs = 2000,
  env = process.env,
}) {
  if (signal?.aborted) throw new Error("Claude Code run aborted");
  const stage = `REVIEW_CLAUDE_${task.toUpperCase()}`;
  const config = getTaskConfig("claude", task, {
    ...env,
    ...(model ? { [`${stage}_MODEL`]: model } : {}),
    ...(effort ? { [`${stage}_EFFORT`]: effort } : {}),
  });
  const readsRepository = allowShell || REPOSITORY_TASKS.has(task);
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--setting-sources", "", "--strict-mcp-config",
    "--model", config.model, "--effort", config.effort,
    "--tools", readsRepository ? READ_TOOLS : "",
  ];
  if (onText && !outputSchema) args.push("--include-partial-messages");
  for (const dir of readsRepository ? readableDirs.filter(Boolean) : []) args.push("--add-dir", dir);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  if (outputSchema) args.push("--json-schema", JSON.stringify(outputSchema));
  const tempDir = mkdtempSync(resolve(tmpdir(), "review-claude-"));
  try {
    const result = await new Promise((resolvePromise, reject) => {
      const grouped = process.platform !== "win32";
      const child = spawn("claude", args, {
        cwd: resolve(cwd), env: { ...env, TMPDIR: tempDir }, stdio: ["pipe", "pipe", "pipe"], detached: grouped,
      });
      const kill = (killSignal) => {
        if (grouped && child.pid) {
          try { process.kill(-child.pid, killSignal); return; } catch (err) {
            if (err.code !== "ESRCH") throw err;
          }
        }
        child.kill(killSignal);
      };
      const reader = claudeEventReader(onText, onActivity);
      let pending = "";
      let stderr = "";
      let stopError = null;
      let spawnError = null;
      let killTimer;
      const stop = (err) => {
        if (stopError) return;
        stopError = err;
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), killGraceMs);
      };
      const abort = () => stop(new Error("Claude Code run aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => stop(new Error(`Claude Code timed out after ${timeoutMs} ms`)), timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text) => {
        pending += text;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try { reader.accept(line); } catch (err) { stop(err); }
        }
      });
      child.stderr.on("data", (text) => { stderr = (stderr + text).slice(-64 * 1024); });
      child.on("error", (err) => { spawnError = err; });
      child.stdin.on("error", (err) => { if (err.code !== "EPIPE") stop(new Error(`Could not send prompt to Claude Code: ${err.message}`)); });
      child.on("close", (code) => {
        if (stopError && grouped) kill("SIGKILL");
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        if (pending) reader.accept(pending);
        const final = reader.result();
        if (spawnError?.code === "ENOENT") {
          const missing = new Error("Claude Code CLI not found. Install it (npm install -g @anthropic-ai/claude-code) and log in to enable full-code review checks.");
          missing.codexSetupFailure = true;
          reject(missing);
        } else if (spawnError) reject(spawnError);
        else if (stopError) reject(stopError);
        else if (!final || final.is_error || final.subtype !== "success") {
          reject(claudeFailure(final?.result || final?.api_error_status || stderr.split("\n").filter(Boolean).slice(-3).join(" "), code));
        } else resolvePromise(final);
      });
      child.stdin.end(userPrompt);
    });
    const usage = result.usage || {};
    onUsage?.({
      input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
      cachedInput: usage.cache_read_input_tokens || 0,
      output: usage.output_tokens || 0,
      reasoningOutput: 0,
    });
    if (outputSchema) {
      if (result.structured_output === undefined) throw new Error("Claude Code completed without structured output");
      return JSON.stringify(result.structured_output);
    }
    if (typeof result.result !== "string") throw new Error("Claude Code completed without a final response");
    return result.result;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
