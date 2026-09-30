import { spawn } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { getTaskConfig } from "./models.js";
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
const CODEX_ERROR_LINE = /^(?:\S+\s+)?ERROR:?\s+(.+)$/i;
// Subsystem noise a run survives: unreachable MCP servers, model-cache warnings,
// hook output. These are `tracing` targets (`crate::module: message`), never the
// error that actually ended the run.
const CODEX_NOISE = /^[a-z_]+(?:::[a-z_]+)+:|^hook:/;
// Failures that will hit every subsequent call the same way, so there is no
// point spawning Codex again for the remaining work.
const CODEX_TIMEOUT_MS = 15 * 60 * 1000;

const CODEX_SETUP_FAILURE =
  /requires a newer version of Codex|unexpected argument .*--(?:ignore-user-config|output-schema)|unknown feature|unsupported model|model .* not (?:found|supported)|not logged in|invalid api key/i;

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
  if (/requires a newer version of Codex|unexpected argument .*--(?:ignore-user-config|output-schema)|unknown feature/i.test(detail)) {
    return "upgrade the Codex CLI (npm install -g @openai/codex); this runner requires --ignore-user-config support";
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

function eventReader(onText) {
  const usage = { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 };
  let failure = null;
  let failedTurn = false;
  const messages = new Map();
  function emit(id, text, delta = false) {
    if (typeof text !== "string") return;
    const previous = messages.get(id) || "";
    const next = delta ? previous + text : text;
    if (next.startsWith(previous) && next.length > previous.length) onText?.(next.slice(previous.length));
    messages.set(id, next);
  }
  return {
    accept(line) {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "turn.completed" && event.usage) {
        usage.input += event.usage.input_tokens || 0;
        usage.cachedInput += event.usage.cached_input_tokens || 0;
        usage.output += event.usage.output_tokens || 0;
        usage.reasoningOutput += event.usage.reasoning_output_tokens || 0;
      } else if (event.type === "turn.failed") {
        failedTurn = true;
        failure = unwrapErrorMessage(event.error?.message) || failure;
      } else if (event.type === "error") {
        failure = unwrapErrorMessage(event.message) || failure;
      }
      const item = event.item;
      if (item?.type === "agent_message" && ["item.started", "item.updated", "item.completed"].includes(event.type)) {
        emit(item.id || "message", item.text);
      } else if (event.type === "item.delta" && (item?.type === "agent_message" || !item)) {
        emit(item?.id || event.item_id || "message", event.delta?.text ?? event.delta, true);
      } else if (event.type === "response.output_text.delta") {
        emit(event.item_id || "message", event.delta, true);
      }
    },
    result: () => ({ usage, failure, failedTurn }),
  };
}

export function parseCodexEvents(stdout) {
  const reader = eventReader();
  for (const line of stdout.split("\n")) reader.accept(line);
  const { usage, failure } = reader.result();
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

/** Run a read-only, ephemeral task, preserving CLI auth but ignoring user config. */
export async function runCodex({
  systemPrompt,
  userPrompt,
  cwd = process.cwd(),
  task = "generation",
  model,
  effort,
  ignoreProjectInstructions = true,
  outputSchema,
  onText,
  onProgress,
  onUsage,
  signal,
  timeoutMs = CODEX_TIMEOUT_MS,
  killGraceMs = 2000,
  env = process.env,
}) {
  if (signal?.aborted) throw new Error("Codex run aborted");
  const stage = `REVIEW_CODEX_${task.toUpperCase()}`;
  const config = getTaskConfig("codex", task, {
    ...env,
    ...(model ? { [`${stage}_MODEL`]: model } : {}),
    ...(effort ? { [`${stage}_EFFORT`]: effort } : {}),
  });
  const tempDir = mkdtempSync(join(tmpdir(), "review-codex-"));
  const outputPath = join(tempDir, "last-message.txt");
  const workDir = resolve(cwd);
  const args = [
    "exec", "--ephemeral", "--json", "--color", "never",
    "--sandbox", "read-only", "--skip-git-repo-check",
    "--ignore-user-config", "--output-last-message", outputPath,
    "--model", config.model,
    "-c", `model_reasoning_effort=${JSON.stringify(config.effort)}`,
    "-c", 'approval_policy="never"',
    "--disable", "hooks", "--disable", "plugins", "--disable", "apps",
    "--enable", "skip_host_skill_discovery",
  ];
  if (task !== "investigation") args.push("--disable", "shell_tool", "--disable", "shell_snapshot");
  // Untrusted roots skip project .codex layers. Keep CODEX_HOME for existing auth.
  let root = workDir;
  while (dirname(root) !== root && !existsSync(join(root, ".git"))) root = dirname(root);
  if (!existsSync(join(root, ".git"))) root = workDir;
  for (const path of new Set([workDir, root])) {
    args.push("-c", `projects.${JSON.stringify(path)}.trust_level="untrusted"`);
  }
  if (ignoreProjectInstructions) args.push("-c", "project_doc_max_bytes=0");
  const prompt = [
    systemPrompt ? `<instructions>\n${systemPrompt}\n</instructions>` : "",
    `<request>\n${userPrompt}\n</request>`,
  ].filter(Boolean).join("\n\n");

  try {
    if (outputSchema) {
      const schemaPath = join(tempDir, "output-schema.json");
      writeFileSync(schemaPath, JSON.stringify(outputSchema));
      args.push("--output-schema", schemaPath);
    }
    args.push("-");
    await new Promise((resolvePromise, reject) => {
      const grouped = process.platform !== "win32";
      const child = spawn("codex", args, {
        cwd: workDir, env, stdio: ["pipe", "pipe", "pipe"], detached: grouped,
      });
      const kill = (signal) => {
        if (grouped && child.pid) {
          try { process.kill(-child.pid, signal); return; } catch (err) {
            if (err.code !== "ESRCH") throw err;
          }
        }
        child.kill(signal);
      };
      const reader = eventReader(onText);
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
      const abort = () => stop(new Error("Codex run aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => stop(new Error(`Codex timed out after ${timeoutMs} ms`)), timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text) => {
        pending += text;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.length > 4 * 1024 * 1024) {
            stop(new Error("Codex JSON event exceeded 4 MB"));
            continue;
          }
          try { reader.accept(line); } catch (err) { stop(err); }
        }
        if (pending.length > 4 * 1024 * 1024) {
          pending = "";
          stop(new Error("Codex JSON event exceeded 4 MB"));
        }
      });
      child.stderr.on("data", (text) => {
        stderr = (stderr + text).slice(-64 * 1024);
        try { onProgress?.(text); } catch (err) { stop(err); }
      });
      child.on("error", (err) => { spawnError = err; });
      child.stdin.on("error", (err) => stop(new Error(`Could not send prompt to Codex: ${err.message}`)));
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        try {
          if (pending) reader.accept(pending);
          const { usage, failure, failedTurn } = reader.result();
          if (spawnError?.code === "ENOENT") {
            const missing = new Error("Codex CLI not found. Install it or run with --claude.");
            missing.codexSetupFailure = true;
            reject(missing);
          } else if (spawnError) reject(spawnError);
          else if (stopError) reject(stopError);
          else if (code !== 0 || failedTurn) reject(codexFailure(code, stderr, prompt, failure));
          else {
            onUsage?.(usage);
            resolvePromise();
          }
        } catch (err) { reject(err); }
      });
      // EPIPE means Codex exited before reading the prompt; "close" reports why.
      child.stdin.on("error", (err) => {
        if (err.code !== "EPIPE") reject(err);
      });

      child.stdin.end(prompt);
    });
    try {
      return readFileSync(outputPath, "utf-8");
    } catch (err) {
      throw new Error(`Codex completed without a readable final response: ${err.message}`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
