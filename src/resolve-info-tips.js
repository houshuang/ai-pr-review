/**
 * Verify and resolve review tips in the background.
 *
 * Runs as a detached process after generate.js writes the walkthrough JSON
 * (with every tip marked pending), so the viewer opens immediately:
 *
 *   Stage 1 — verify all pending tips against the diff in one batch call.
 *             Tips that resolve as verified/concern are finalized.
 *   Stage 2 — tips the diff alone couldn't settle are investigated in the
 *             actual codebase with tool use (grep/read_file/list_files).
 *             For GitHub PRs, if the invoking directory isn't a clone of the
 *             PR's repo, a shallow clone at the PR head is created/reused
 *             under .cache/repos/.
 *
 * As each tip resolves, the JSON is rewritten in place so the viewer's
 * polling loop picks up the update.
 *
 * Usage: node src/resolve-info-tips.js <slug> [repo-path]
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { resolve, dirname, relative, join } from "path";
import { fileURLToPath } from "url";
import { GENERATION_MODEL } from "./models.js";

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

const MAX_TOOL_ROUNDS = 50;
const MAX_CONCURRENCY = 3;
const MAX_GREP_LINES = 120;
const MAX_READ_LINES = 400;
// Generous because thinking tokens count toward max_tokens on Opus 5.
const MAX_TOKENS_PER_ROUND = 8000;

function extractText(response) {
  return response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

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

// Ensure a local checkout of the PR's repo at the PR head. Shallow-clones into
// .cache/repos/ on first use, then just fetches pull/<N>/head (which also
// works for PRs from forks) on later runs.
function ensureRepoClone(owner, repo, number) {
  const cacheDir = resolve(__dirname, "..", ".cache", "repos");
  mkdirSync(cacheDir, { recursive: true });
  const dir = resolve(cacheDir, `${owner}-${repo}`);
  const opts = { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 };
  if (!existsSync(resolve(dir, ".git"))) {
    log("INFO", `Shallow-cloning ${owner}/${repo} for tip investigation...`);
    execFileSync("gh", ["repo", "clone", `${owner}/${repo}`, dir, "--", "--depth", "1", "--no-checkout", "--quiet"], opts);
  }
  execFileSync("git", ["fetch", "--depth", "1", "--quiet", "origin", `pull/${number}/head`], { ...opts, cwd: dir });
  execFileSync("git", ["checkout", "--detach", "--force", "--quiet", "FETCH_HEAD"], { ...opts, cwd: dir });
  return dir;
}

// Manage prompt-cache breakpoints for the tool loop. Each round re-sends the
// whole conversation; without caching that costs O(rounds²) input tokens.
// Breakpoints: the shared instructions+diff block (identical across all tip
// investigations, so concurrent tips hit each other's cache) plus the two most
// recent user messages (so each round reads the prior rounds from cache).
function setCacheBreakpoints(messages) {
  const userIdxs = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (Array.isArray(m.content)) for (const b of m.content) delete b.cache_control;
    if (m.role === "user") userIdxs.push(i);
  }
  const first = messages[0];
  if (Array.isArray(first.content)) first.content[0].cache_control = { type: "ephemeral" };
  for (const i of userIdxs.slice(-2)) {
    const m = messages[i];
    if (Array.isArray(m.content) && m.content.length) {
      m.content[m.content.length - 1].cache_control = { type: "ephemeral" };
    }
  }
}

// --- Stage 1: batch verification against the diff (no repo access needed) ---

async function verifyTipsAgainstDiff(client, tips, diff) {
  log("INFO", `Verifying ${tips.length} review tips against the diff...`);

  const prompt = `You are a code reviewer verifying specific review concerns against the actual diff.

For EACH tip below, examine the diff and determine:
- "verified": You checked and the code looks correct — the concern is addressed or not an issue.
- "concern": You checked and there IS a real issue, risk, or the concern is valid.
- "info": Cannot be fully determined from the diff alone (e.g. requires runtime testing, checking files not in the diff, or external context).

Be precise and cite specific evidence from the diff. If a tip mentions a file/line, look at that exact location.

Return ONLY a JSON array (no wrapping object, no markdown fences):
[
  {
    "tip": "the original tip text, verbatim",
    "status": "verified|concern|info",
    "finding": "1-2 sentences: what you found, with file:line references to evidence"
  }
]

## Tips to Verify
${tips.map((t, i) => `${i + 1}. ${t.tip}`).join("\n")}

## Diff
\`\`\`diff
${diff.slice(0, 400000)}${diff.length > 400000 ? "\n... (diff truncated — treat tips about unseen files as \"info\")" : ""}
\`\`\``;

  try {
    const stream = client.messages.stream({
      model: GENERATION_MODEL,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });
    const response = await stream.finalMessage();
    const text = extractText(response);
    log("INFO", `Tip verification: ${response.usage?.input_tokens} input / ${response.usage?.output_tokens} output tokens`);

    // Thinking models can emit several fenced blocks — take the largest
    // candidate that parses into a verdict array, not the first fence.
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
    const candidates = [];
    let m;
    while ((m = fenceRe.exec(text))) {
      if (m[1].trim()) candidates.push(m[1].trim());
    }
    candidates.push(text.trim());
    candidates.sort((a, b) => b.length - a.length);
    let verified = [];
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        const arr = Array.isArray(parsed) ? parsed : parsed.verified_tips || parsed.tips || [];
        if (arr.length > 0) {
          verified = arr;
          break;
        }
      } catch {}
    }
    if (verified.length !== tips.length) {
      log("WARN", `Verification returned ${verified.length} tips but expected ${tips.length}`);
    }
    return verified.length > 0 ? verified : null;
  } catch (err) {
    log("WARN", `Tip verification failed (${err.message}) — sending all tips to investigation`);
    return null;
  }
}

// --- Stage 2: tool-use investigation of tips the diff couldn't settle ---

async function resolveTip(client, tip, repoPath, diffContext) {
  const tipText = typeof tip === "string" ? tip : tip.tip;
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `You are verifying a code review concern that couldn't be fully determined from the diff alone. Use the tools to investigate the actual codebase and produce a final verdict.

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
        {
          type: "text",
          text: `## The concern\n${tipText}\n${tip.finding ? `\n## What we've established so far\n${tip.finding}\n` : ""}`,
        },
      ],
    },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // On the final round, drop the tools and tell the model to commit. This
    // salvages the investigation instead of discarding it: it always has one
    // turn where its only move is to emit the verdict JSON.
    const lastRound = round === MAX_TOOL_ROUNDS - 1;
    if (lastRound) {
      messages.push({
        role: "user",
        content:
          "You've used your full investigation budget. Stop searching and produce your final verdict now as the JSON block, based on everything you've found so far. If you're still uncertain, say so in the finding and use status \"info\".",
      });
    }
    setCacheBreakpoints(messages);
    const response = await client.messages.create({
      model: GENERATION_MODEL,
      max_tokens: MAX_TOKENS_PER_ROUND,
      tools: lastRound ? undefined : TOOLS,
      messages,
    });
    inputTokens += response.usage?.input_tokens || 0;
    outputTokens += response.usage?.output_tokens || 0;
    cacheRead += response.usage?.cache_read_input_tokens || 0;
    cacheWrite += response.usage?.cache_creation_input_tokens || 0;

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const text = extractText(response);
      // The final verdict is the LAST fenced block — earlier fences may be
      // the echoed format example or an interim sketch.
      const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].reverse();
      for (const fence of fences) {
        try {
          const parsed = JSON.parse(fence[1]);
          if (parsed.status && parsed.finding) {
            return {
              tip: tipText,
              status: parsed.status,
              finding: parsed.finding,
              pending: false,
              resolved: true,
              usage: { input: inputTokens, output: outputTokens, cacheRead, cacheWrite, rounds: round + 1 },
            };
          }
        } catch {}
      }
      // No valid JSON — degrade
      return {
        tip: tipText,
        status: "info",
        finding: text.slice(0, 400) || "No final verdict from investigation.",
        pending: false,
        resolved: true,
        usage: { input: inputTokens, output: outputTokens, cacheRead, cacheWrite, rounds: round + 1 },
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
    tip: tipText,
    status: "info",
    finding: "Investigation exceeded tool round limit without reaching a verdict.",
    pending: false,
    resolved: true,
    usage: { input: inputTokens, output: outputTokens, cacheRead, cacheWrite, rounds: MAX_TOOL_ROUNDS },
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
  if (!resolved.pending) delete tips[idx].pending;
  writeFileSync(jsonPath, JSON.stringify(content, null, 2));
  return true;
}

// Update the per-PR JSON and mirror to the default walkthrough-data.json when
// it holds the same walkthrough.
function applyTipUpdate(jsonPath, content, tip, resolved) {
  const wrote = updateTipInFile(jsonPath, tip, resolved);
  if (wrote) {
    const defaultPath = resolve(__dirname, "..", "public", "walkthrough-data.json");
    if (existsSync(defaultPath)) {
      try {
        const def = JSON.parse(readFileSync(defaultPath, "utf-8"));
        if (def?.meta && content?.meta && def.meta.headSha === content.meta.headSha) {
          updateTipInFile(defaultPath, tip, resolved);
        }
      } catch {}
    }
  }
  return wrote;
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
  const cwdRepoPath = args[1] ? resolve(args[1]) : process.cwd();

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
  const meta = content?.meta || {};

  const pendingTips = tips.filter((t) => typeof t === "object" && t.pending);
  if (pendingTips.length === 0) {
    log("INFO", "No pending tips to process");
    return;
  }

  const client = new Anthropic({ apiKey, timeout: 5 * 60 * 1000, maxRetries: 2 });

  // Stage 1: verify everything against the diff in one batch call. Tips that
  // the diff alone settles are finalized; the rest stay pending with the
  // partial finding attached, and go to tool investigation.
  const verdicts = await verifyTipsAgainstDiff(client, pendingTips, diff);
  const remaining = [];
  for (let i = 0; i < pendingTips.length; i++) {
    const tip = pendingTips[i];
    const v =
      (verdicts || []).find((x) => x.tip === tip.tip) ||
      (verdicts && verdicts.length === pendingTips.length ? verdicts[i] : null);
    if (v && (v.status === "verified" || v.status === "concern")) {
      applyTipUpdate(jsonPath, content, tip, {
        status: v.status,
        finding: v.finding,
        resolved: true,
        pending: false,
      });
    } else {
      const enriched = { ...tip, status: "info", finding: v?.finding || tip.finding };
      applyTipUpdate(jsonPath, content, tip, {
        status: "info",
        finding: enriched.finding,
        pending: true,
      });
      remaining.push(enriched);
    }
  }
  log("INFO", `Verification: ${pendingTips.length - remaining.length}/${pendingTips.length} settled from the diff, ${remaining.length} need investigation`);

  if (remaining.length === 0) return;

  // Stage 2: pick the repo to investigate. For GitHub PRs prefer the invoking
  // directory if it's a clone of the PR's repo; otherwise use a cached shallow
  // clone at the PR head. --local/--diff reviews always use the invoking dir.
  let repoPath = cwdRepoPath;
  if (meta.owner && meta.repo && meta.number) {
    let cwdMatches = false;
    try {
      const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
        cwd: cwdRepoPath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      cwdMatches = remote.includes(`${meta.owner}/${meta.repo}`);
    } catch {}
    if (!cwdMatches) {
      try {
        repoPath = ensureRepoClone(meta.owner, meta.repo, meta.number);
      } catch (err) {
        log("WARN", `Could not clone ${meta.owner}/${meta.repo}: ${err.message} — leaving remaining tips unresolved`);
        for (const tip of remaining) {
          applyTipUpdate(jsonPath, content, tip, {
            status: "info",
            finding: tip.finding || "Could not be verified from the diff; codebase unavailable for investigation.",
            resolved: true,
            pending: false,
          });
        }
        return;
      }
    }
  }

  log("INFO", `Investigating ${remaining.length} tips for ${slug} (repo: ${repoPath})`);

  let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalRounds = 0;
  let resolvedCount = 0;

  await runPool(remaining, async (tip, i) => {
    log("INFO", `[${i + 1}/${remaining.length}] Resolving: ${tip.tip.slice(0, 80)}...`);
    const resolved = await resolveTip(client, tip, repoPath, diff);
    const wrote = applyTipUpdate(jsonPath, content, tip, resolved);
    if (wrote) {
      resolvedCount++;
      log("INFO", `[${i + 1}/${remaining.length}] Resolved → ${resolved.status} (${resolved.usage.rounds} rounds, ${resolved.usage.input} uncached + ${resolved.usage.cacheRead} cached in / ${resolved.usage.output} out)`);
    } else {
      log("WARN", `[${i + 1}/${remaining.length}] Could not find tip in JSON to update`);
    }
    totalIn += resolved.usage.input;
    totalOut += resolved.usage.output;
    totalCacheRead += resolved.usage.cacheRead;
    totalRounds += resolved.usage.rounds;
  }, MAX_CONCURRENCY);

  log("INFO", `Done. Resolved ${resolvedCount}/${remaining.length}. Total: ${totalRounds} tool rounds, ${totalIn} uncached + ${totalCacheRead} cached input / ${totalOut} output tokens.`);
}

main().catch((err) => {
  log("ERROR", `Resolver failed: ${err.message}`);
  if (err.stack) log("ERROR", err.stack);
  process.exit(1);
});
