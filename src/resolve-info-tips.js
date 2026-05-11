/**
 * Resolve "info"-status review tips by investigating the codebase with tool use.
 *
 * Intended to run as a detached background process after generate.js writes the
 * walkthrough JSON. As each tip resolves, the JSON is rewritten in place so the
 * viewer's polling loop picks up the update.
 *
 * Usage: node src/resolve-info-tips.js <slug> [repo-path]
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { resolve, dirname, relative, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOG_DIR = resolve(__dirname, "..", "logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = resolve(LOG_DIR, `resolve-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);

function log(level, ...args) {
  const msg = `[${new Date().toISOString()}] [${level}] ${args.join(" ")}`;
  appendFileSync(LOG_FILE, msg + "\n");
}

function loadEnvKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const envPath = resolve(__dirname, "..", ".env");
    if (existsSync(envPath)) {
      const lines = readFileSync(envPath, "utf-8").split("\n");
      for (const line of lines) {
        const match = line.match(/^ANTHROPIC_(?:API_)?KEY=(.+)$/);
        if (match) return match[1].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
  return null;
}

const MAX_TOOL_ROUNDS = 30;
const MAX_CONCURRENCY = 3;
const MAX_GREP_LINES = 120;
const MAX_READ_LINES = 400;

const TOOLS = [
  {
    name: "grep",
    description: "Search the codebase for a pattern. Uses git grep (Perl-compatible regex). Returns matching lines with 'path:line:text' format.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for." },
        path: { type: "string", description: "Optional pathspec (e.g. 'src/', '*.ts', ':!node_modules'). Leave empty to search everything tracked by git." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the repo, optionally a slice by line range. Reads max 400 lines.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to repo root." },
        start_line: { type: "number", description: "1-indexed start line (optional)." },
        end_line: { type: "number", description: "1-indexed end line, inclusive (optional)." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List tracked files in the repo matching a git pathspec. Useful for discovering files before reading them.",
    input_schema: {
      type: "object",
      properties: {
        pathspec: { type: "string", description: "Git pathspec (e.g. 'src/**/*.tsx', 'Dockerfile', '*.md')." },
      },
      required: ["pathspec"],
    },
  },
];

function safePath(repoPath, userPath) {
  const abs = resolve(repoPath, userPath);
  const rel = relative(repoPath, abs);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path escapes repo: ${userPath}`);
  }
  return abs;
}

function runGrep(repoPath, pattern, path) {
  const args = ["grep", "-nI", "--max-count=10", "-P", "-e", pattern];
  if (path) args.push("--", path);
  try {
    const out = execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = out.split("\n").filter(Boolean);
    if (lines.length > MAX_GREP_LINES) {
      return lines.slice(0, MAX_GREP_LINES).join("\n") + `\n... (truncated, ${lines.length - MAX_GREP_LINES} more lines)`;
    }
    return lines.join("\n") || "(no matches)";
  } catch (err) {
    if (err.status === 1) return "(no matches)";
    return `Error: ${err.message}`;
  }
}

function runReadFile(repoPath, path, startLine, endLine) {
  let abs;
  try {
    abs = safePath(repoPath, path);
  } catch (err) {
    return `Error: ${err.message}`;
  }
  if (!existsSync(abs)) return `Error: file not found: ${path}`;
  let content;
  try {
    content = readFileSync(abs, "utf-8");
  } catch (err) {
    return `Error reading ${path}: ${err.message}`;
  }
  const allLines = content.split("\n");
  let start = Math.max(1, startLine || 1);
  let end = Math.min(allLines.length, endLine || allLines.length);
  if (end - start + 1 > MAX_READ_LINES) end = start + MAX_READ_LINES - 1;
  const slice = allLines.slice(start - 1, end);
  const numbered = slice.map((l, i) => `${start + i}: ${l}`).join("\n");
  const suffix = end < allLines.length ? `\n... (file has ${allLines.length} lines; showing ${start}-${end})` : "";
  return numbered + suffix;
}

function runListFiles(repoPath, pathspec) {
  try {
    const out = execFileSync("git", ["ls-files", "--", pathspec], {
      cwd: repoPath,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
    });
    const lines = out.split("\n").filter(Boolean);
    if (lines.length > 200) {
      return lines.slice(0, 200).join("\n") + `\n... (truncated, ${lines.length - 200} more files)`;
    }
    return lines.join("\n") || "(no files match)";
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function executeTool(toolName, input, repoPath) {
  try {
    if (toolName === "grep") return runGrep(repoPath, input.pattern, input.path);
    if (toolName === "read_file") return runReadFile(repoPath, input.path, input.start_line, input.end_line);
    if (toolName === "list_files") return runListFiles(repoPath, input.pathspec);
    return `Error: unknown tool ${toolName}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

async function resolveTip(client, tip, repoPath, diffContext) {
  const messages = [
    {
      role: "user",
      content: `You are verifying a code review concern that couldn't be fully determined from the diff alone. Use the tools to investigate the actual codebase and produce a final verdict.

## The concern
${typeof tip === "string" ? tip : tip.tip}

${tip.finding ? `## What we've established so far\n${tip.finding}\n` : ""}
## Diff being reviewed (for context)
\`\`\`diff
${diffContext.slice(0, 8000)}${diffContext.length > 8000 ? "\n... (truncated)" : ""}
\`\`\`

## Your task
Use grep, list_files, and read_file to investigate. Be thorough but efficient — chase down every concrete claim in the concern (every call site, every related file). You have up to ${MAX_TOOL_ROUNDS} tool rounds; use what you need. Then produce a final verdict as a JSON block:

\`\`\`json
{ "status": "verified|concern|info", "finding": "1-3 sentences with specific file:line references to evidence" }
\`\`\`

Status meanings:
- verified: you investigated and the concern is addressed or not an issue
- concern: you found a real issue
- info: even with tool access, this genuinely requires runtime testing / external context

Do NOT produce the final JSON until you've actually looked at the code. Don't guess.`,
    },
  ];

  let inputTokens = 0;
  let outputTokens = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      tools: TOOLS,
      messages,
    });
    inputTokens += response.usage?.input_tokens || 0;
    outputTokens += response.usage?.output_tokens || 0;

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const text = response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const match = text.match(/```json\s*([\s\S]*?)```/);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          if (parsed.status && parsed.finding) {
            return {
              tip: typeof tip === "string" ? tip : tip.tip,
              status: parsed.status,
              finding: parsed.finding,
              pending: false,
              resolved: true,
              usage: { input: inputTokens, output: outputTokens, rounds: round + 1 },
            };
          }
        } catch {}
      }
      // No valid JSON — degrade
      return {
        tip: typeof tip === "string" ? tip : tip.tip,
        status: "info",
        finding: text.slice(0, 400) || "No final verdict from investigation.",
        pending: false,
        resolved: true,
        usage: { input: inputTokens, output: outputTokens, rounds: round + 1 },
      };
    }

    const toolUses = response.content.filter((c) => c.type === "tool_use");
    if (toolUses.length === 0) break;
    const toolResults = toolUses.map((tu) => ({
      type: "tool_result",
      tool_use_id: tu.id,
      content: String(executeTool(tu.name, tu.input, repoPath)).slice(0, 20000),
    }));
    messages.push({ role: "user", content: toolResults });
  }

  return {
    tip: typeof tip === "string" ? tip : tip.tip,
    status: "info",
    finding: "Investigation exceeded tool round limit without reaching a verdict.",
    pending: false,
    resolved: true,
    usage: { input: inputTokens, output: outputTokens, rounds: MAX_TOOL_ROUNDS },
  };
}

// Atomically update a single tip in the walkthrough JSON.
// Matches by tip text so concurrent writes don't clobber each other and so
// user-triggered regenerations in between are handled safely (if the tip
// doesn't exist anymore, we just skip the update).
function updateTipInFile(jsonPath, original, resolved) {
  if (!existsSync(jsonPath)) return false;
  const content = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const tips = content?.walkthrough?.review_tips;
  if (!Array.isArray(tips)) return false;
  const originalText = typeof original === "string" ? original : original.tip;
  const idx = tips.findIndex((t) => {
    const txt = typeof t === "string" ? t : t.tip;
    return txt === originalText && (typeof t === "object" ? t.pending : true);
  });
  if (idx === -1) return false;
  tips[idx] = { ...tips[idx], ...resolved };
  delete tips[idx].pending;
  writeFileSync(jsonPath, JSON.stringify(content, null, 2));
  return true;
}

async function runPool(items, worker, concurrency) {
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        await worker(items[i], i);
      } catch (err) {
        log("ERROR", `Worker ${i} threw: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node resolve-info-tips.js <slug> [repo-path]");
    process.exit(1);
  }
  const slug = args[0];
  const repoPath = args[1] ? resolve(args[1]) : process.cwd();

  const jsonPath = resolve(__dirname, "..", "public", "walkthroughs", `${slug}.json`);
  if (!existsSync(jsonPath)) {
    log("ERROR", `Walkthrough not found: ${jsonPath}`);
    process.exit(1);
  }

  const apiKey = loadEnvKey();
  if (!apiKey) {
    log("ERROR", "No ANTHROPIC_API_KEY found — cannot resolve info tips");
    process.exit(1);
  }

  const content = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const tips = content?.walkthrough?.review_tips || [];
  const diff = content?.diff || "";

  const pendingTips = tips.filter((t) => typeof t === "object" && t.pending);
  if (pendingTips.length === 0) {
    log("INFO", "No pending info tips to resolve");
    return;
  }

  log("INFO", `Resolving ${pendingTips.length} pending info tips for ${slug} (repo: ${repoPath})`);

  const client = new Anthropic({ apiKey, timeout: 5 * 60 * 1000, maxRetries: 2 });

  let totalIn = 0, totalOut = 0, totalRounds = 0;
  let resolvedCount = 0;

  await runPool(pendingTips, async (tip, i) => {
    log("INFO", `[${i + 1}/${pendingTips.length}] Resolving: ${tip.tip.slice(0, 80)}...`);
    const resolved = await resolveTip(client, tip, repoPath, diff);
    const wrote = updateTipInFile(jsonPath, tip, resolved);
    if (wrote) {
      resolvedCount++;
      // Also update the default walkthrough-data.json if it matches this slug
      const defaultPath = resolve(__dirname, "..", "public", "walkthrough-data.json");
      if (existsSync(defaultPath)) {
        try {
          const def = JSON.parse(readFileSync(defaultPath, "utf-8"));
          if (def?.meta && content?.meta && def.meta.headSha === content.meta.headSha) {
            updateTipInFile(defaultPath, tip, resolved);
          }
        } catch {}
      }
      log("INFO", `[${i + 1}/${pendingTips.length}] Resolved → ${resolved.status} (${resolved.usage.rounds} rounds, ${resolved.usage.input}/${resolved.usage.output} tokens)`);
    } else {
      log("WARN", `[${i + 1}/${pendingTips.length}] Could not find tip in JSON to update`);
    }
    totalIn += resolved.usage.input;
    totalOut += resolved.usage.output;
    totalRounds += resolved.usage.rounds;
  }, MAX_CONCURRENCY);

  log("INFO", `Done. Resolved ${resolvedCount}/${pendingTips.length}. Total: ${totalRounds} tool rounds, ${totalIn} input / ${totalOut} output tokens.`);
}

main().catch((err) => {
  log("ERROR", `Resolver failed: ${err.message}`);
  if (err.stack) log("ERROR", err.stack);
  process.exit(1);
});
