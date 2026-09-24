import { spawn } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { CODEX_MODEL } from "./models.js";
import { normalizeProvider, resolveProviderSync } from "./provider-config.js";

/**
 * An explicit value (e.g. the provider recorded in a walkthrough) wins;
 * otherwise REVIEW_AI_PROVIDER, the saved default, then the non-interactive
 * fallback.
 */
export function resolveAIProvider(value) {
  return value ? normalizeProvider(value) : resolveProviderSync().provider;
}

// `codex exec` writes its whole human-readable transcript to stderr — banner,
// the echoed prompt, MCP chatter, hook lines — and reserves stdout for machine
// output. Tailing stderr on failure therefore captures the prompt rather than
// the failure, so pull out the lines that actually report an error.
const CODEX_ERROR_LINE = /^(?:\S+\s+)?ERROR:?\s+(.+)$/;
// Subsystem noise a run survives: unreachable MCP servers, model-cache warnings,
// hook output. These are `tracing` targets (`crate::module: message`), never the
// error that actually ended the run.
const CODEX_NOISE = /^[a-z_]+(?:::[a-z_]+)+:|^hook:/;
// Failures that will hit every subsequent call the same way, so there is no
// point spawning Codex again for the remaining work.
const CODEX_TIMEOUT_MS = 15 * 60 * 1000;

const CODEX_SETUP_FAILURE =
  /requires a newer version of Codex|unsupported model|model .* not (?:found|supported)|not logged in|invalid api key/i;

function codexErrorDetail(stderr, prompt) {
  // The prompt is echoed back verbatim; drop those lines so nothing we sent can
  // be mistaken for something Codex reported.
  const echoed = new Set(prompt.split("\n").map((l) => l.trim()).filter(Boolean));
  const primary = [];
  const secondary = [];
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    if (!line || echoed.has(line)) continue;
    const match = line.match(CODEX_ERROR_LINE);
    if (!match) continue;
    const msg = unwrapErrorMessage(match[1].trim());
    (CODEX_NOISE.test(msg) ? secondary : primary).push(msg);
  }
  // Retries repeat the same message; report it once. Keep the last few — the
  // error that terminated the run is the one at the end.
  const found = [...new Set(primary.length ? primary : secondary)].slice(-3);
  const detail = found.length
    ? found.join(" ")
    : stderr.split("\n").map((l) => l.trim()).filter((l) => l && !echoed.has(l)).slice(-3).join(" ");
  return detail.slice(0, 400);
}

function codexHint(detail) {
  if (/requires a newer version of Codex/i.test(detail)) {
    return "upgrade the Codex CLI (npm install -g @openai/codex), or set REVIEW_CODEX_MODEL to a model your CLI supports";
  }
  if (/not logged in|invalid api key|\b401\b/i.test(detail)) return "run `codex login`";
  if (/model .* not supported|unsupported model/i.test(detail)) return "unset REVIEW_CODEX_MODEL or pick a model your Codex account supports";
  return null;
}

function unwrapErrorMessage(msg) {
  if (typeof msg !== "string" || !msg.startsWith("{")) return msg;
  try {
    const parsed = JSON.parse(msg);
    return parsed?.error?.message || parsed?.message || msg;
  } catch {
    return msg;
  }
}

// With --json, stdout carries one event per line: agent messages, usage on
// `turn.completed`, and the terminating error on `turn.failed`.
export function parseCodexEvents(stdout) {
  const usage = { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 };
  let failure = null;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "turn.completed" && event.usage) {
      usage.input += event.usage.input_tokens || 0;
      usage.cachedInput += event.usage.cached_input_tokens || 0;
      usage.output += event.usage.output_tokens || 0;
      usage.reasoningOutput += event.usage.reasoning_output_tokens || 0;
    } else if (event.type === "turn.failed") {
      failure = unwrapErrorMessage(event.error?.message) || failure;
    } else if (event.type === "error" && !failure) {
      failure = unwrapErrorMessage(event.message);
    }
  }
  return { usage, failure };
}

export function formatCodexUsage(usage) {
  if (!usage) return "usage unavailable";
  return `${usage.input} input (${usage.cachedInput} cached) / ${usage.output} output tokens`;
}

function codexFailure(code, stderr, prompt, eventFailure) {
  const detail = (eventFailure || codexErrorDetail(stderr, prompt)).slice(0, 400);
  const hint = codexHint(detail);
  const err = new Error(
    `Codex exited with code ${code}${detail ? `: ${detail}` : ""}${hint ? ` — ${hint}` : ""}`
  );
  err.codexSetupFailure = CODEX_SETUP_FAILURE.test(detail);
  return err;
}

/**
 * Run a one-shot Codex task and return only its final response.
 *
 * Prompts are sent over stdin so large PR diffs never hit shell argument limits.
 * The child is read-only and ephemeral: it may inspect a repo for tip resolution,
 * but it cannot edit the reviewed codebase or leave a persisted Codex session.
 * `onUsage` receives the token counts; `signal` and `timeoutMs` stop the child.
 */
export async function runCodex({
  systemPrompt,
  userPrompt,
  cwd = process.cwd(),
  model = CODEX_MODEL,
  ignoreProjectInstructions = true,
  onProgress,
  onUsage,
  signal,
  timeoutMs = CODEX_TIMEOUT_MS,
}) {
  const tempDir = mkdtempSync(join(tmpdir(), "review-codex-"));
  const outputPath = join(tempDir, "last-message.txt");
  const args = [
    "exec",
    "--ephemeral",
    "--json",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--output-last-message",
    outputPath,
  ];
  if (ignoreProjectInstructions) args.push("--ignore-rules");
  if (model) args.push("--model", model);
  args.push("-");

  const prompt = [
    systemPrompt ? `<instructions>\n${systemPrompt}\n</instructions>` : "",
    `<request>\n${userPrompt}\n</request>`,
  ].filter(Boolean).join("\n\n");

  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn("codex", args, {
        cwd: resolve(cwd),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        onProgress?.(text);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          const missing = new Error("Codex CLI not found. Install it or run with --claude.");
          missing.codexSetupFailure = true;
          reject(missing);
        } else {
          reject(err);
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const { usage, failure } = parseCodexEvents(stdout);
        if (code === 0) {
          onUsage?.(usage);
          resolvePromise();
        } else if (timedOut) {
          reject(new Error(`Codex timed out after ${Math.round(timeoutMs / 60000)} minutes`));
        } else if (signal?.aborted) {
          reject(new Error("Codex run aborted"));
        } else {
          reject(codexFailure(code, stderr, prompt, failure));
        }
      });
      child.stdin.on("error", reject);
      child.stdin.end(prompt);
    });
    return readFileSync(outputPath, "utf-8");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
