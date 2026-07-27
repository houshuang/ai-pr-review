/**
 * Generate a walkthrough JSON from a GitHub PR or local git diff.
 *
 * Usage:
 *   node src/generate.js https://github.com/owner/repo/pull/123
 *   node src/generate.js --local [base-branch]
 *   node src/generate.js --diff path/to/diff.patch
 */

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  RateLimitError,
  InternalServerError,
} from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, openSync } from "fs";
import { execSync, spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { sanitizeWalkthroughDiagrams } from "./mermaid-sanitize.js";
import { GENERATION_MODEL, REPAIR_MODEL } from "./models.js";
import { Agent as UndiciAgent } from "undici";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Logging ---
const LOG_DIR = resolve(__dirname, "..", "logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = resolve(LOG_DIR, `generate-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);

function log(level, ...args) {
  const msg = `[${new Date().toISOString()}] [${level}] ${args.join(" ")}`;
  appendFileSync(LOG_FILE, msg + "\n");
  if (level === "ERROR") {
    console.error(...args);
  } else {
    console.log(...args);
  }
}

// --- JSON parse / repair / dump for Claude responses ---

function dumpFailedResponse(text, err) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(LOG_DIR, `failed-response-${stamp}.txt`);
  const header = `# Failed to parse walkthrough JSON\n# Error: ${err.message}\n# Saved: ${new Date().toISOString()}\n# Length: ${text.length} chars\n\n`;
  writeFileSync(path, header + text);
  return path;
}

// Iteratively repair JSON by escaping the offending character at the position
// reported by JSON.parse's error message. Catches the dominant Claude failure
// mode: a stray unescaped `"` or control char inside a string value.
function tryRepairJSON(text) {
  let candidate = text
    .replace(/,(\s*[}\]])/g, "$1") // trailing commas
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""); // raw control chars
  for (let i = 0; i < 200; i++) {
    try {
      return JSON.parse(candidate);
    } catch (e) {
      const m = e.message.match(/position (\d+)/);
      if (!m) return null;
      const pos = parseInt(m[1], 10);
      if (pos < 0 || pos >= candidate.length) return null;
      const ch = candidate[pos];
      // Walk back: are we inside a string literal? Quick heuristic — count
      // unescaped `"` from the start. Odd count = inside a string.
      let quotes = 0;
      for (let k = 0; k < pos; k++) {
        if (candidate[k] === '"' && candidate[k - 1] !== "\\") quotes++;
      }
      const insideString = quotes % 2 === 1;
      if (insideString && (ch === '"' || ch === "\n" || ch === "\r" || ch === "\t")) {
        const escaped = ch === '"' ? '\\"' : ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t";
        candidate = candidate.slice(0, pos) + escaped + candidate.slice(pos + 1);
        continue;
      }
      // Common: missing comma between values — try inserting one
      if (!insideString && /[}\]"\d]/.test(candidate[pos - 1] || "") && /[\{\["a-zA-Z\d]/.test(ch)) {
        candidate = candidate.slice(0, pos) + "," + candidate.slice(pos);
        continue;
      }
      return null;
    }
  }
  return null;
}

// Concatenate all text blocks. Models with extended thinking (e.g. Opus 5)
// may return a thinking block first, so content[0] is not necessarily text.
function extractText(response) {
  return response.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function repairJSONWithClaude(text, client) {
  log("INFO", "Local repair failed — asking Claude to fix the JSON...");
  try {
    const stream = client.messages.stream({
      model: REPAIR_MODEL,
      max_tokens: 64000,
      system:
        "You are a JSON repair tool. The user provides a malformed JSON document. Return ONLY the corrected JSON — no commentary, no markdown fences. Preserve all content exactly; only fix syntax errors (unescaped quotes inside strings, raw newlines inside strings, missing/trailing commas, control characters).",
      messages: [{ role: "user", content: text }],
    });
    const response = await stream.finalMessage();
    log("INFO", `Repair response: ${response.usage?.input_tokens} input / ${response.usage?.output_tokens} output tokens`);
    const fixed = extractText(response);
    const jsonMatch = fixed.match(/```json\s*([\s\S]*?)```/) || [null, fixed];
    return JSON.parse(jsonMatch[1].trim());
  } catch (err) {
    log("WARN", `Claude repair failed: ${err.message}`);
    return null;
  }
}

// --- Diff parsing, filtering, and prioritization for large PRs ---

/**
 * Parse a unified diff into per-file entries.
 * Each entry: { path, isNew, isDeleted, isRenamed, diffText, addedLines, removedLines, diffLines }
 */
function parseDiffIntoFiles(diff) {
  const files = [];
  const chunks = diff.split(/^(?=diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const headerMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;
    const path = headerMatch[2];
    const isNew = /^new file mode/m.test(chunk);
    const isDeleted = /^deleted file mode/m.test(chunk);
    const isRenamed = /^rename from/m.test(chunk);
    let addedLines = 0;
    let removedLines = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) addedLines++;
      if (line.startsWith("-") && !line.startsWith("---")) removedLines++;
    }
    files.push({ path, isNew, isDeleted, isRenamed, diffText: chunk, addedLines, removedLines, diffLines: chunk.split("\n").length });
  }
  return files;
}

// --- Generated / noise file detection ---

const GENERATED_EXACT = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Gemfile.lock",
  "Cargo.lock", "composer.lock", "poetry.lock", "Pipfile.lock",
  "go.sum", "flake.lock", "packages.lock.json",
]);

const GENERATED_PATTERNS = [
  /\.min\.(js|css)$/,                   // minified assets
  /\.bundle\.(js|css)$/,                // bundled assets
  /\.pb\.(go|h|cc)$/,                   // protobuf output
  /_pb2\.pyi?$/,                        // protobuf Python
  /\.generated\.\w+$/,                  // explicitly generated
  /\.snap$/,                            // jest snapshots
  /\.snap\.tsx?$/,
  /\.svg$/,                             // SVG assets (usually not hand-written)
  /vendor\//,                           // vendored deps
  /node_modules\//,
  /\.graphql\.ts$/,                     // codegen GraphQL types
  /\.schema\.json$/,                    // generated schemas
  /dist\//,                             // build output
];

const LARGE_FILE_THRESHOLD = 2000; // changed lines

function isGeneratedFile(filePath, changedLines) {
  const basename = filePath.split("/").pop();
  if (GENERATED_EXACT.has(basename)) return true;
  if (GENERATED_PATTERNS.some(p => p.test(filePath))) return true;
  if (changedLines > LARGE_FILE_THRESHOLD) return true;
  return false;
}

/**
 * Build a focused diff using 5-tier graceful degradation:
 *   Tier 0: Full diff (under budget)
 *   Tier 1: Drop generated/noise files
 *   Tier 2: Truncate large new files to ~200 lines each
 *   Tier 3: For remaining new files, keep only hunk headers + first 50 lines
 *   Tier 4: Hard-truncate the assembled diff to budget
 *
 * Returns { diff, largePRSummary, filteredFiles }
 */
function buildFocusedDiff(fullDiff, maxDiffLines = 15000) {
  const files = parseDiffIntoFiles(fullDiff);
  const totalLines = fullDiff.split("\n").length;

  // Separate generated files from real files
  const realFiles = [];
  const generatedFiles = [];
  for (const f of files) {
    if (isGeneratedFile(f.path, f.addedLines + f.removedLines)) {
      generatedFiles.push(f);
    } else {
      realFiles.push(f);
    }
  }

  if (generatedFiles.length > 0) {
    log("INFO", `Filtered ${generatedFiles.length} generated/noise files: ${generatedFiles.map(f => f.path).join(", ")}`);
  }

  // Tier 0: If real files fit, we're done
  const realDiff = realFiles.map(f => f.diffText).join("\n");
  const realLineCount = realDiff.split("\n").length;

  const filteredSummary = generatedFiles.map(f =>
    `- ${f.path} (${f.isNew ? "new" : "modified"}, +${f.addedLines}/-${f.removedLines} lines, auto-excluded)`
  );

  if (realLineCount <= maxDiffLines) {
    return {
      diff: realDiff,
      largePRSummary: generatedFiles.length > 0 ? {
        totalFiles: files.length,
        includedFiles: realFiles.length,
        filteredFiles: generatedFiles.length,
        filteredSummary,
        tier: generatedFiles.length > 0 ? 1 : 0,
        originalLineCount: totalLines,
        focusedLineCount: realLineCount,
      } : null,
      filteredFiles: generatedFiles,
    };
  }

  // Tier 1+: Need to cut further. Prioritize modified/deleted over new.
  const modified = realFiles.filter(f => !f.isNew && !f.isDeleted);
  const deleted = realFiles.filter(f => f.isDeleted);
  const newFiles = realFiles.filter(f => f.isNew);

  // Modified and deleted always included in full
  const priorityParts = [...modified, ...deleted].map(f => f.diffText);
  let priorityDiff = priorityParts.join("\n");
  const priorityLines = priorityDiff.split("\n").length;
  let remainingBudget = maxDiffLines - priorityLines;

  // Tier 2: Fit new files, truncating large ones to ~200 lines
  const sortedNew = [...newFiles].sort((a, b) => a.diffLines - b.diffLines);
  const includedNew = [];
  const truncatedNew = [];
  const summarizedNew = [];

  for (const f of sortedNew) {
    if (f.diffLines <= remainingBudget) {
      includedNew.push(f);
      remainingBudget -= f.diffLines;
    } else if (remainingBudget > 200) {
      // Tier 2: truncate to ~200 lines
      const lines = f.diffText.split("\n");
      const truncated = lines.slice(0, 200).join("\n") + `\n... (truncated, ${lines.length - 200} more lines)`;
      truncatedNew.push({ ...f, diffText: truncated, diffLines: 201 });
      remainingBudget -= 201;
    } else {
      summarizedNew.push(f);
    }
  }

  const parts = [priorityDiff];
  for (const f of [...includedNew, ...truncatedNew]) {
    parts.push(f.diffText);
  }
  let assembledDiff = parts.join("\n");

  // Tier 4: Hard-truncate if still over
  const assembledLines = assembledDiff.split("\n");
  if (assembledLines.length > maxDiffLines) {
    assembledDiff = assembledLines.slice(0, maxDiffLines).join("\n") + "\n... (diff truncated to fit context budget)";
  }

  const summary = {
    totalFiles: files.length,
    includedFiles: modified.length + deleted.length + includedNew.length + truncatedNew.length,
    filteredFiles: generatedFiles.length,
    filteredSummary,
    summarizedFiles: summarizedNew.map(f => `- ${f.path} (new file, +${f.addedLines} lines)`),
    truncatedFiles: truncatedNew.map(f => `- ${f.path} (truncated to 200 lines from ${f.addedLines})`),
    tier: summarizedNew.length > 0 ? 3 : truncatedNew.length > 0 ? 2 : 1,
    originalLineCount: totalLines,
    focusedLineCount: Math.min(assembledDiff.split("\n").length, maxDiffLines),
  };

  log("INFO", `Large PR: ${totalLines} diff lines → focused to ${summary.focusedLineCount} (tier ${summary.tier})`);
  log("INFO", `  ${modified.length} modified, ${deleted.length} deleted (full)`);
  log("INFO", `  ${includedNew.length} new (full), ${truncatedNew.length} new (truncated), ${summarizedNew.length} new (summarized)`);
  if (generatedFiles.length) log("INFO", `  ${generatedFiles.length} generated/noise files filtered`);

  return { diff: assembledDiff, largePRSummary: summary, filteredFiles: generatedFiles };
}

function loadEnvKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // Check for .env file in the tool's own directory (not cwd)
  const localEnv = resolve(__dirname, "..", ".env");
  if (existsSync(localEnv)) {
    const lines = readFileSync(localEnv, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^ANTHROPIC_(?:API_)?KEY=(.+)$/);
      if (match) return match[1].trim();
    }
  }
  return null;
}

// Ensure a local checkout of the PR's repo at the PR head, for the background
// tip investigator. Shallow-clones into .cache/repos/ on first use, then just
// fetches pull/<N>/head (which also works for PRs from forks) on later runs.
function ensureRepoClone(owner, repo, number) {
  const cacheDir = resolve(__dirname, "..", ".cache", "repos");
  mkdirSync(cacheDir, { recursive: true });
  const dir = resolve(cacheDir, `${owner}-${repo}`);
  const gitOpts = { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 };
  if (!existsSync(resolve(dir, ".git"))) {
    console.log(`\n⟳ Shallow-cloning ${owner}/${repo} for tip investigation...`);
    execSync(`gh repo clone ${owner}/${repo} "${dir}" -- --depth 1 --no-checkout --quiet`, gitOpts);
  }
  execSync(`git fetch --depth 1 --quiet origin pull/${number}/head`, { ...gitOpts, cwd: dir });
  execSync(`git checkout --detach --force --quiet FETCH_HEAD`, { ...gitOpts, cwd: dir });
  return dir;
}

function fetchGitHistory(owner, repo, number, pr) {
  const result = { commits: [], fileAges: {}, churn: {} };
  const execOpts = { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 };

  // 1. Fetch detailed commits in the PR
  try {
    const commitsJson = execSync(
      `gh api repos/${owner}/${repo}/pulls/${number}/commits --paginate`,
      execOpts
    );
    const commits = JSON.parse(commitsJson);
    result.commits = commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      fullSha: c.sha,
      author: c.commit.author.name,
      date: c.commit.author.date,
      message: c.commit.message.split("\n")[0],
    }));

    // 2. Detect file churn — how many commits touched each file
    const fileTouches = {};
    for (const c of commits) {
      try {
        const detail = JSON.parse(
          execSync(`gh api repos/${owner}/${repo}/commits/${c.sha}`, execOpts)
        );
        for (const f of detail.files || []) {
          fileTouches[f.filename] = (fileTouches[f.filename] || 0) + 1;
        }
      } catch {
        // Skip commits we can't fetch details for
      }
    }
    for (const [path, count] of Object.entries(fileTouches)) {
      if (count >= 2) {
        result.churn[path] = { touchCount: count };
      }
    }
  } catch {
    console.warn("Could not fetch PR commits");
  }

  // 3. Fetch file ages — when was each changed file last modified on the base branch
  const changedFiles = (pr.files || []).map((f) => f.path);
  for (const filePath of changedFiles.slice(0, 30)) {
    try {
      const historyJson = execSync(
        `gh api "repos/${owner}/${repo}/commits?path=${encodeURIComponent(filePath)}&sha=${pr.baseRefName}&per_page=1"`,
        execOpts
      );
      const history = JSON.parse(historyJson);
      if (history.length > 0) {
        const lastDate = history[0].commit.author.date;
        result.fileAges[filePath] = {
          lastModified: lastDate,
          lastAuthor: history[0].commit.author.name,
          daysSince: Math.floor(
            (Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24)
          ),
        };
      }
    } catch {
      // New file or API error
    }
  }

  return result;
}

async function fetchPRData(prUrl) {
  const match = prUrl.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (!match) throw new Error(`Invalid PR URL: ${prUrl}`);
  const [, owner, repo, number] = match;

  console.log(`Fetching PR #${number} from ${owner}/${repo}...`);

  // Use gh CLI to fetch PR data
  const prJson = execSync(
    `gh pr view ${number} --repo ${owner}/${repo} --json title,body,url,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,commits,files`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
  );
  const pr = JSON.parse(prJson);

  // Fetch the full diff — fall back to local git if GitHub API rejects (too large)
  let diff;
  try {
    diff = execSync(
      `gh pr diff ${number} --repo ${owner}/${repo}`,
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
    );
  } catch (diffErr) {
    const errMsg = diffErr.stderr?.toString() || diffErr.message || "";
    if (errMsg.includes("too_large") || errMsg.includes("406")) {
      log("INFO", `GitHub diff API rejected PR (too large). Falling back to local git diff...`);
      // Use the original CWD (where user ran the command) — likely the repo
      const repoCwd = process.env.REVIEW_ORIGINAL_CWD || process.cwd();
      try {
        execSync(`git fetch origin ${pr.baseRefName} ${pr.headRefName}`, {
          encoding: "utf-8",
          stdio: "pipe",
          cwd: repoCwd,
        });
        diff = execSync(
          `git diff origin/${pr.baseRefName}...origin/${pr.headRefName}`,
          { encoding: "utf-8", maxBuffer: 100 * 1024 * 1024, cwd: repoCwd }
        );
        log("INFO", `Local git diff: ${(diff.length / 1024).toFixed(1)}KB (from ${repoCwd})`);
      } catch (gitErr) {
        throw new Error(
          `GitHub diff API rejected this PR as too large, and local git diff also failed.\n` +
          `GitHub error: ${errMsg.trim()}\n` +
          `Git error: ${gitErr.message}\n` +
          `Tried repo at: ${repoCwd}\n\n` +
          `Try running from inside the repo: cd <repo> && review --local ${pr.baseRefName}`
        );
      }
    } else {
      throw new Error(`Failed to fetch PR diff: ${errMsg.trim()}`);
    }
  }

  // Re-check head SHA after the diff fetch. If it changed, the PR was updated
  // mid-fetch and our diff may not match `pr.headRefOid`. Keep the older SHA so
  // the StaleBanner correctly flags the walkthrough as out of date on view.
  if (pr.headRefOid) {
    try {
      const verifyJson = execSync(
        `gh pr view ${number} --repo ${owner}/${repo} --json headRefOid`,
        { encoding: "utf-8" }
      );
      const verify = JSON.parse(verifyJson);
      if (verify.headRefOid && verify.headRefOid !== pr.headRefOid) {
        console.warn(
          `\n⚠ PR head changed during fetch: ${pr.headRefOid.slice(0, 7)} → ${verify.headRefOid.slice(0, 7)}.\n` +
          `  The diff may be inconsistent with the recorded SHA. The viewer will flag this walkthrough as stale.\n`
        );
      }
    } catch {
      // Verification is best-effort — don't fail the whole run if it errors.
    }
  }

  // Fetch existing review comments
  console.log("Fetching review comments...");
  let comments = [];
  try {
    const commentsJson = execSync(
      `gh api repos/${owner}/${repo}/pulls/${number}/comments --paginate`,
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
    );
    comments = JSON.parse(commentsJson);
  } catch {
    console.warn("Could not fetch review comments");
  }

  // Fetch reviews (approve/request changes/comment)
  let reviews = [];
  try {
    const reviewsJson = execSync(
      `gh api repos/${owner}/${repo}/pulls/${number}/reviews --paginate`,
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
    );
    reviews = JSON.parse(reviewsJson);
  } catch {
    console.warn("Could not fetch reviews");
  }

  // Fetch git history metadata
  console.log("Fetching git history metadata...");
  const gitHistory = fetchGitHistory(owner, repo, number, pr);

  return {
    source: "github",
    owner,
    repo,
    number: parseInt(number),
    title: pr.title,
    url: prUrl,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    headSha: pr.headRefOid || null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    body: pr.body || "",
    files: pr.files || [],
    diff,
    comments: comments.map((c) => ({
      id: c.id,
      path: c.path,
      line: c.line || c.original_line,
      side: c.side || "RIGHT",
      body: c.body,
      user: c.user?.login,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      inReplyToId: c.in_reply_to_id || null,
      diffHunk: c.diff_hunk,
    })),
    reviews: reviews.map((r) => ({
      id: r.id,
      user: r.user?.login,
      state: r.state,
      body: r.body,
      submittedAt: r.submitted_at,
    })),
    gitHistory,
  };
}

function fetchLocalDiff(baseBranch = "main") {
  console.log(`Generating diff against ${baseBranch}...`);

  const diff = execSync(`git diff ${baseBranch}...HEAD`, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const stat = execSync(`git diff --stat ${baseBranch}...HEAD`, {
    encoding: "utf-8",
  });
  const log = execSync(`git log --oneline ${baseBranch}..HEAD`, {
    encoding: "utf-8",
  });
  const branch = execSync("git branch --show-current", {
    encoding: "utf-8",
  }).trim();
  const headSha = execSync("git rev-parse HEAD", {
    encoding: "utf-8",
  }).trim();

  // Count additions/deletions from stat
  const statMatch = stat.match(
    /(\d+) files? changed(?:, (\d+) insertions?)?(?:, (\d+) deletions?)?/
  );

  return {
    source: "local",
    title: branch,
    url: "",
    baseBranch,
    headBranch: branch,
    headSha,
    additions: statMatch ? parseInt(statMatch[2] || "0") : 0,
    deletions: statMatch ? parseInt(statMatch[3] || "0") : 0,
    changedFiles: statMatch ? parseInt(statMatch[1] || "0") : 0,
    body: log,
    files: [],
    diff,
  };
}

function readDiffFile(path) {
  console.log(`Reading diff from ${path}...`);
  const diff = readFileSync(path, "utf-8");
  return {
    source: "file",
    title: path,
    url: "",
    baseBranch: "unknown",
    headBranch: "unknown",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    body: "",
    files: [],
    diff,
  };
}

const SYSTEM_PROMPT = `You are a senior engineer creating an interactive code review walkthrough. You will receive a PR diff and metadata. Your job is to produce a structured JSON walkthrough that guides the reviewer through the changes in a logical narrative order.

## Core Philosophy

Think structurally, not textually. A diff is not "lines added and removed" — it is a set of semantic transformations applied to a codebase. Your job is to identify those transformations and explain them in human terms:

- "The function signature gains a new parameter" (not "lines 10-12 were changed")
- "This block is wrapped in a try/catch" (not "these lines were added around existing code")
- "The type definition moves from inline to a shared export" (not "removed here, added there")
- "The object spread replaces a conditional chain" (a structural refactor, not random edits)

Anchor explanations on what HASN'T changed to orient the reader, then describe the delta. The reader already has the diff — your value is making sense of it.

## Output Schema

The output must be valid JSON matching this schema:

{
  "title": "string - concise walkthrough title, not just the PR title — capture the essence of what changed",
  "subtitle": "string - one sentence explaining the motivation, not just the mechanics",
  "overview": "string - 2-3 paragraphs in markdown. Start with the problem/motivation, then the approach, then the impact. The first paragraph should make sense to someone who hasn't read the code.",
  "architecture_diagram": "string - mermaid.js diagram showing the structural change. Default to \`flowchart TD\` (top-down) — it uses page width well. Use \`flowchart LR\` only for short before→after pairs (≤4 nodes per side). Inside every subgraph, declare \`direction TB\` so inner nodes stack vertically. Aim for an aspect ratio near 4:3 or taller; never wider than 2:1. Show the data/control flow, not one box per file.",
  "sections": [
    {
      "id": "string - kebab-case identifier",
      "title": "string - active voice, describes the transformation (e.g. 'Extract renderer capabilities into modules' not 'Module Extraction')",
      "narrative": "string - markdown. Open with context (what exists, what's stable), then explain the change and why it matters. Connect to the previous section. End with what this enables for the next section. Write for a peer engineer who is smart but unfamiliar with this code.",
      "diagram": "string|null - mermaid diagram for this section, or null. Use when the section involves data flow, state transitions, or relationships between components. Do NOT add diagrams just for decoration.",
      "hunks": [
        {
          "file": "string - file path exactly as it appears in the diff",
          "startLine": "number - start line in the NEW file (right side of diff)",
          "endLine": "number - end line in the NEW file",
          "annotation": "string - describe the CHANGE, not the resulting code. Bad: 'Exports configuration modules'. Good: 'Replaces the monolithic export with individual module re-exports, establishing the composable pattern used by all renderers'. Focus on the delta.",
          "importance": "critical|important|supporting|context"
        }
      ],
      "callouts": [
        {
          "type": "insight|warning|pattern|tradeoff|question",
          "label": "string - 2-4 word label",
          "text": "string - explanation. For 'question' type: a specific thing the reviewer should verify."
        }
      ]
    }
  ],
  "file_map": [
    {
      "path": "string - exact file path from the diff",
      "description": "string - what changed in this file and why (not just what the file is)",
      "is_new": "boolean"
    }
  ],
  "review_tips": ["string - specific, actionable review guidance with file:line references where possible"]
}

## CRITICAL RULES

- file_map MUST list EVERY file in the diff. No exceptions. This ensures the reviewer sees all code.
- Every hunk must reference real file paths and line numbers from the diff. Verify the numbers.
- Mermaid diagrams must use valid mermaid syntax. Do NOT wrap in \`\`\`mermaid fences — the raw mermaid text is rendered directly.
- In Mermaid node labels, ALWAYS use quoted syntax when the label contains | : < > # or other special characters. Example: A["label with | pipe"] not A[label with | pipe]. The pipe character is especially dangerous as Mermaid interprets it as an edge-label delimiter.
- Use ONLY standard Mermaid arrow syntax: --> for normal arrows, ==> for thick arrows, -.-> for dotted arrows. NEVER use unicode arrows like ──→, ──>, ⟶, or other non-ASCII arrow characters.
- Keep each node definition on its own line. Do NOT put multiple node definitions like A["x"] --> B["y"] --> C["z"] on a single line — split them into separate lines.

## Guidelines

STRUCTURE:
- Group related changes across files into logical sections (2-5 files each).
- Order sections for progressive understanding: foundations first (types, interfaces), then core transforms, then wiring/integration, then tests/config.
- Each section should build on the previous — explicitly say "Building on the module structure from Section 1..." when relevant.
- Name sections with active verbs describing the transformation, not passive nouns.

NARRATIVE QUALITY:
- Write like you're walking a peer through the PR at a whiteboard, not writing release notes.
- Open each section by grounding the reader: what exists, what's stable, what's about to change.
- Explain structural changes explicitly: code that was moved, code that was wrapped, code that was split apart, code that was consolidated.
- Be opinionated about tradeoffs — what alternatives existed and why this approach was chosen.
- When a change fixes a bug, explain how the bug manifested, not just that it was fixed.
- Connect implementation choices to broader software engineering principles when it's genuinely illuminating (not just for show).

ANNOTATIONS:
- Annotations describe the CHANGE (the delta), not the result. The reader can see what the code IS — tell them what it WAS and WHY it changed.
- For moved code: "Extracted from the monolithic config object (previously at line N) into its own module"
- For wrapped code: "Existing logic is now guarded by a mutation-mode check, leaving the inner behavior unchanged"
- For new code: "New module implementing hydration stubs — the noop renderer doesn't support hydration, so each function throws a descriptive error"
- For deleted code: "Removes the inline type that is now properly exported from ReactFiberConfigNoop.js"

IMPORTANCE LEVELS:
- "critical": Core logic changes, security-sensitive code, bug fixes, API surface changes — must be reviewed carefully.
- "important": Key behavioral changes, new patterns being established — should be reviewed.
- "supporting": Boilerplate, mechanical propagation, config changes — skim-worthy.
- "context": Unchanged code referenced to provide understanding — shown for orientation.

CALLOUTS:
- "insight": A non-obvious consequence or benefit of the change.
- "warning": A risk, gotcha, or potential issue the reviewer should watch for.
- "pattern": A design pattern being established or followed — explain why it matters.
- "tradeoff": An explicit tradeoff made — what was gained and what was given up.
- "question": Something the reviewer should specifically verify or think about.

WHAT TO SKIP in sections (leave for "Remaining Changes"):
- Import statement updates that mechanically follow from the structural changes
- Signature propagation where a parameter flows through unchanged
- Re-exports that mirror the new module structure
- Config file tweaks (ESLint, tsconfig) unless they reveal design decisions

DIAGRAMS:
- Architecture diagram: Show the structural transformation (before→after, or the new flow). Use subgraphs to group related components.
- Section diagrams: Use when showing data flow, state machines, decision trees, or component relationships. Skip when the section is straightforward.
- Keep diagrams focused — 5-12 nodes maximum. Dense diagrams are worse than no diagram.
- LAYOUT — diagrams are rendered in a page-wide container, so they MUST use vertical space, not stretch horizontally:
  - Default to \`flowchart TD\`. Reserve \`flowchart LR\` for tiny 2-column before/after comparisons.
  - Inside every \`subgraph\`, the FIRST line must be \`direction TB\` so nodes stack vertically even if the parent is LR.
  - Never produce a single linear chain of 5+ nodes in a row. Either branch the flow, group steps into a subgraph, or insert intermediate fan-out/fan-in nodes so dagre has something to stack.
  - Target aspect ratio is roughly square or taller (height ≥ width). A diagram wider than 2× its height is wrong — restructure it.
  - When you have multiple subgraphs at the top level, stack them vertically (one per "row") rather than placing them side by side.

GIT HISTORY (when provided):
- Use commit history to understand the author's development sequence and mention it when illuminating.
- If a file was iterated on multiple times (high churn), note this as it suggests complexity or refinement.
- Use code age data to contextualize changes: "This module, untouched for 2 years, now gains..." or "Recently active area with 3 changes this month."
- If review comments exist AND code was changed in subsequent commits, mention that the code was revised in response to feedback.
- Don't mechanically list commit history — weave relevant insights into the narrative naturally.`;

function formatGitHistoryForPrompt(gitHistory) {
  if (!gitHistory) return "";
  const parts = [];

  if (gitHistory.commits?.length > 0) {
    parts.push(`**Commit History (${gitHistory.commits.length} commits):**`);
    for (const c of gitHistory.commits) {
      parts.push(`- ${c.sha} ${c.author} (${new Date(c.date).toLocaleDateString()}): ${c.message}`);
    }
  }

  const churnEntries = Object.entries(gitHistory.churn || {});
  if (churnEntries.length > 0) {
    parts.push(`\n**Files with multiple revisions during this PR (high iteration):**`);
    for (const [path, info] of churnEntries.sort((a, b) => b[1].touchCount - a[1].touchCount)) {
      parts.push(`- ${path}: touched ${info.touchCount} times`);
    }
  }

  const ageEntries = Object.entries(gitHistory.fileAges || {});
  if (ageEntries.length > 0) {
    parts.push(`\n**Code age (last modified on base branch):**`);
    for (const [path, info] of ageEntries.sort((a, b) => b.daysSince - a.daysSince)) {
      const age = info.daysSince > 365
        ? `${Math.floor(info.daysSince / 365)}y ago`
        : info.daysSince > 30
          ? `${Math.floor(info.daysSince / 30)}mo ago`
          : `${info.daysSince}d ago`;
      parts.push(`- ${path}: last changed ${age} by ${info.lastAuthor}`);
    }
  }

  return parts.length > 0 ? "\n" + parts.join("\n") + "\n" : "";
}

async function verifyReviewTips(tips, diff, client) {
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
${tips.map((t, i) => `${i + 1}. ${t}`).join("\n")}

## Diff
\`\`\`diff
${diff}
\`\`\``;

  try {
    const stream = client.messages.stream({
      model: GENERATION_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const response = await stream.finalMessage();
    const text = extractText(response);
    log("INFO", `Tip verification: ${response.usage?.input_tokens} input / ${response.usage?.output_tokens} output tokens`);

    // Parse JSON — may be wrapped in ```json fences
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || [null, text];
    const parsed = JSON.parse(jsonMatch[1].trim());
    const verified = Array.isArray(parsed) ? parsed : parsed.verified_tips || parsed.tips || [];

    if (verified.length > 0) {
      if (verified.length !== tips.length) {
        log("WARN", `Verification returned ${verified.length} tips but expected ${tips.length}`);
      }
      return verified;
    }
    log("WARN", "Verification returned empty results, using unverified tips");
  } catch (err) {
    log("WARN", `Tip verification failed (${err.message}), using unverified tips`);
  }

  // Fallback: return original tips as info-status objects
  return tips.map((t) => ({ tip: t, status: "info", finding: "Verification unavailable" }));
}

async function generateWalkthrough(prData, previousWalkthrough = null) {
  const apiKey = loadEnvKey();
  if (!apiKey) {
    throw new Error(
      "No Anthropic API key found. Set ANTHROPIC_API_KEY env var or add ANTHROPIC_API_KEY=... to .env in project root"
    );
  }

  const client = new Anthropic({
    apiKey,
    timeout: 15 * 60 * 1000, // 15 minutes — large diffs need time
    maxRetries: 3,
    fetchOptions: {
      dispatcher: new UndiciAgent({
        connect: { keepAlive: true, keepAliveInitialDelay: 5000 },
        bodyTimeout: 15 * 60 * 1000,
        headersTimeout: 15 * 60 * 1000,
      }),
    },
  });

  // For large diffs, focus on code that interacts with existing system
  const { diff: focusedDiff, largePRSummary, filteredFiles } = buildFocusedDiff(prData.diff);

  let largePRContext = "";
  if (largePRSummary) {
    const parts = [`**⚠️ Focused Review Mode (tier ${largePRSummary.tier})**`];
    parts.push(`Original: ${largePRSummary.totalFiles} files, ${largePRSummary.originalLineCount} diff lines → Focused: ${largePRSummary.includedFiles} files, ${largePRSummary.focusedLineCount} lines.`);
    parts.push("");
    parts.push("Prioritization: modified/deleted files (full) > small new files (full) > large new files (truncated) > remaining (summarized).");
    if (largePRSummary.filteredSummary?.length) {
      parts.push(`\nGenerated/noise files excluded (${largePRSummary.filteredFiles}):`);
      parts.push(...largePRSummary.filteredSummary);
    }
    if (largePRSummary.truncatedFiles?.length) {
      parts.push(`\nTruncated files:`);
      parts.push(...largePRSummary.truncatedFiles);
    }
    if (largePRSummary.summarizedFiles?.length) {
      parts.push(`\nOmitted files (summary only):`);
      parts.push(...largePRSummary.summarizedFiles);
    }
    parts.push("\nFocus on how changes integrate with the existing system.");
    largePRContext = "\n" + parts.join("\n") + "\n";
  }

  let previousContext = "";
  if (previousWalkthrough) {
    previousContext = `
**⟳ INCREMENTAL UPDATE — Previous walkthrough provided below.**
The branch has been updated with new commits since the last generation. Use the previous walkthrough as a starting point: keep sections that are still accurate, update line numbers and annotations for changed code, and add/remove sections as needed. Do NOT regenerate from scratch — preserve the narrative structure where possible.

<previous_walkthrough>
${JSON.stringify(previousWalkthrough)}
</previous_walkthrough>

`;
  }

  const userPrompt = `${previousWalkthrough ? "Update" : "Create"} a walkthrough for this PR.

**Title:** ${prData.title}
**Branch:** ${prData.headBranch} → ${prData.baseBranch}
**Stats:** +${prData.additions} -${prData.deletions} across ${prData.changedFiles} files
${prData.url ? `**URL:** ${prData.url}` : ""}
${prData.body ? `\n**PR Description:**\n${prData.body}` : ""}
${prData.comments?.length ? `\n**Existing Review Comments (${prData.comments.length}):**\n${prData.comments.map((c) => `- ${c.user} on ${c.path}:${c.line}: ${c.body}`).join("\n")}` : ""}
${prData.reviews?.length ? `\n**Reviews:** ${prData.reviews.map((r) => `${r.user}: ${r.state}`).join(", ")}` : ""}
${formatGitHistoryForPrompt(prData.gitHistory)}
${largePRContext}${previousContext}**${largePRSummary ? "Focused" : "Full"} Diff:**
\`\`\`diff
${focusedDiff}
\`\`\`

Generate the walkthrough JSON. Important reminders:
- Every hunk must reference real file paths and line numbers from the diff above
- Annotations should describe the CHANGE (what was different before), not just describe the resulting code
- Mermaid diagrams: raw mermaid syntax only, do NOT wrap in \`\`\`mermaid code fences
- file_map must include every file in the diff${largePRSummary ? " (including summarized/filtered files — mark them with a note that diff was omitted or auto-excluded)" : ""}`;

  log("INFO", "Sending to Claude API...");
  log("INFO", `Diff size: ${(focusedDiff.length / 1024).toFixed(1)}KB${largePRSummary ? ` (focused from ${(prData.diff.length / 1024).toFixed(1)}KB)` : ""}`);

  let response;
  try {
    // Use streaming to prevent TCP read timeouts on large diffs.
    // With non-streaming, long silent waits between request and response
    // trigger OS/network-level ETIMEDOUT errors. Streaming keeps data flowing.
    const stream = client.messages.stream({
      model: GENERATION_MODEL,
      max_tokens: 64000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    // Log progress as tokens arrive
    let tokenCount = 0;
    stream.on("text", () => {
      tokenCount++;
      if (tokenCount === 1) log("INFO", "First token received, streaming...");
      if (tokenCount % 2000 === 0) log("INFO", `  ...${tokenCount} tokens received`);
    });

    response = await stream.finalMessage();
  } catch (err) {
    if (err instanceof APIConnectionTimeoutError) {
      log("ERROR", "API request timed out after 15 minutes (including retries)");
    } else if (err instanceof APIConnectionError) {
      log("ERROR", `API connection failed: ${err.message}${err.cause ? ` (cause: ${err.cause})` : ""}`);
    } else if (err instanceof RateLimitError) {
      const retryAfter = err.headers?.["retry-after"];
      log("ERROR", `Rate limited (429)${retryAfter ? ` — retry after ${retryAfter}s` : ""}`);
    } else if (err instanceof InternalServerError) {
      log("ERROR", `API server error (${err.status}): ${err.message}`);
    } else if (err.status) {
      log("ERROR", `API error (${err.status}): ${err.message}`);
    }
    throw err;
  }

  log("INFO", `API response: ${response.stop_reason}, ${response.usage?.input_tokens} input / ${response.usage?.output_tokens} output tokens`);
  const text = extractText(response);

  // Extract JSON from the response (it might be wrapped in ```json blocks)
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || [null, text];
  const jsonStr = jsonMatch[1].trim();

  let walkthrough;
  try {
    walkthrough = JSON.parse(jsonStr);
  } catch (e1) {
    const objMatch = text.match(/\{[\s\S]*\}/);
    const candidate = objMatch ? objMatch[0] : jsonStr;
    walkthrough = tryRepairJSON(candidate);
    if (walkthrough) {
      log("INFO", `JSON repaired locally (original parse error: ${e1.message})`);
    } else {
      const dumpPath = dumpFailedResponse(text, e1);
      log("WARN", `Local repair failed. Raw response dumped to: ${dumpPath}`);
      walkthrough = await repairJSONWithClaude(candidate, client);
      if (walkthrough) {
        log("INFO", "JSON repaired via Claude (Haiku)");
      } else {
        throw new Error(
          `Failed to parse walkthrough JSON: ${e1.message}\n` +
          `Raw response saved to: ${dumpPath}\n` +
          `Inspect the file and consider re-running with --force.`
        );
      }
    }
  }

  // Fix common Mermaid syntax issues (e.g. unquoted pipes in node labels)
  sanitizeWalkthroughDiagrams(walkthrough);

  // Verify review tips against the actual diff
  if (walkthrough.review_tips?.length) {
    walkthrough.review_tips = await verifyReviewTips(
      walkthrough.review_tips,
      focusedDiff,
      client
    );
    // Mark info-status tips as pending so the background resolver will pick
    // them up and the viewer can show a spinner for them.
    for (const t of walkthrough.review_tips) {
      if (typeof t === "object" && t.status === "info") t.pending = true;
    }
  }

  return walkthrough;
}

// --- Incremental update: compute delta diff between previous and current head ---

const INCREMENTAL_DELTA_KB_MAX = 30;
const INCREMENTAL_AFFECTED_FILES_MAX = 8;

function computeDeltaDiff(prData, oldSha) {
  if (!oldSha || !prData.headSha || oldSha === prData.headSha) return null;
  if (prData.source !== "github" && prData.source !== "local") return null;

  if (prData.source === "github") {
    try {
      return execSync(
        `gh api repos/${prData.owner}/${prData.repo}/compare/${oldSha}...${prData.headSha} -H "Accept: application/vnd.github.v3.diff"`,
        { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
      );
    } catch (e) {
      log("WARN", `Could not fetch delta diff from GitHub (${e.message.split("\n")[0]}). Falling back to full regen.`);
      return null;
    }
  }

  // local mode
  try {
    const repoCwd = process.env.REVIEW_ORIGINAL_CWD || process.cwd();
    return execSync(`git diff ${oldSha}..${prData.headSha}`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      cwd: repoCwd,
    });
  } catch (e) {
    log("WARN", `Local git diff failed (${e.message.split("\n")[0]}). Falling back to full regen.`);
    return null;
  }
}

function applyWalkthroughPatch(prev, patch) {
  const next = JSON.parse(JSON.stringify(prev));
  next.sections = next.sections || [];
  next.file_map = next.file_map || [];

  // Sections: remove, update, add
  if (patch.removed_section_ids?.length) {
    const before = next.sections.length;
    const removeSet = new Set(patch.removed_section_ids);
    next.sections = next.sections.filter((s) => !removeSet.has(s.id));
    log("INFO", `  removed ${before - next.sections.length} section(s)`);
  }
  if (patch.updated_sections?.length) {
    for (const { id, section } of patch.updated_sections) {
      if (!section) continue;
      const idx = next.sections.findIndex((s) => s.id === id);
      if (idx >= 0) {
        next.sections[idx] = section;
      } else {
        log("WARN", `  updated_section id '${id}' not found in cached walkthrough; treating as new`);
        next.sections.push(section);
      }
    }
    log("INFO", `  updated ${patch.updated_sections.length} section(s)`);
  }
  if (patch.added_sections?.length) {
    next.sections.push(...patch.added_sections);
    log("INFO", `  added ${patch.added_sections.length} section(s)`);
  }

  // File map: remove, update, add
  const fmc = patch.file_map_changes || {};
  if (fmc.removed?.length) {
    const rm = new Set(fmc.removed);
    next.file_map = next.file_map.filter((f) => !rm.has(f.path));
  }
  if (fmc.updated?.length) {
    for (const upd of fmc.updated) {
      const f = next.file_map.find((x) => x.path === upd.path);
      if (f) Object.assign(f, upd);
      else next.file_map.push(upd);
    }
  }
  if (fmc.added?.length) {
    next.file_map.push(...fmc.added);
  }

  // Architecture diagram: optional replacement
  if (typeof patch.architecture_diagram === "string" && patch.architecture_diagram.trim()) {
    next.architecture_diagram = patch.architecture_diagram;
  }

  // Title/subtitle/overview: only replace if explicitly provided (rare)
  for (const k of ["title", "subtitle", "overview"]) {
    if (typeof patch[k] === "string" && patch[k].trim()) next[k] = patch[k];
  }

  // Review tips: full replacement when provided. Pass plain strings — verification
  // re-runs against the full PR diff downstream.
  if (Array.isArray(patch.review_tips)) {
    next.review_tips = patch.review_tips;
  }

  return next;
}

async function generateIncrementalWalkthrough(prData, previousWalkthrough, deltaDiff, affectedFiles) {
  const apiKey = loadEnvKey();
  if (!apiKey) throw new Error("No Anthropic API key found.");

  const client = new Anthropic({
    apiKey,
    timeout: 15 * 60 * 1000,
    maxRetries: 3,
    fetchOptions: {
      dispatcher: new UndiciAgent({
        connect: { keepAlive: true, keepAliveInitialDelay: 5000 },
        bodyTimeout: 15 * 60 * 1000,
        headersTimeout: 15 * 60 * 1000,
      }),
    },
  });

  // Strip resolved metadata from prior review_tips so the model sees plain strings
  const plainPrev = JSON.parse(JSON.stringify(previousWalkthrough));
  if (Array.isArray(plainPrev.review_tips)) {
    plainPrev.review_tips = plainPrev.review_tips.map((t) =>
      typeof t === "string" ? t : t?.tip || ""
    ).filter(Boolean);
  }

  const systemPrompt = `You are updating an existing PR walkthrough. The branch was previously walked through at an earlier commit; new commits have landed since.

You receive:
1. The PREVIOUS walkthrough JSON — source of truth for unchanged content
2. A DELTA diff — ONLY what changed between the previous and current head SHA
3. A list of AFFECTED FILES

Output ONLY a JSON patch with the minimum changes. Do not return the full walkthrough.

## Patch schema (return exactly this shape, no other content)

\`\`\`json
{
  "updated_sections": [
    { "id": "existing-section-id-from-previous-walkthrough",
      "section": { "id": "same-id", "title": "...", "narrative": "...", "diagram": "... or null", "hunks": [...], "callouts": [...] } }
  ],
  "added_sections":   [ { "id": "new-kebab-id", "title": "...", ... } ],
  "removed_section_ids": ["..."],
  "file_map_changes": {
    "added":   [ { "path": "...", "description": "...", "is_new": true } ],
    "removed": ["path-no-longer-in-pr"],
    "updated": [ { "path": "...", "description": "..." } ]
  },
  "architecture_diagram": "OPTIONAL — only if the structural picture meaningfully changed",
  "review_tips": ["plain string tips covering both previously-found AND newly-introduced issues"]
}
\`\`\`

## Rules

- Only touch a section if at least one of its hunks references a file in the AFFECTED FILES list. Unaffected sections MUST be omitted from the patch entirely.
- When updating a section, return the FULL section object (same schema as the original), not a partial diff. Preserve the existing \`id\` exactly.
- New sections need new unique kebab-case ids (do not collide with existing ones).
- If no sections need changes, omit the array (or return empty).
- file_map_changes: only include the delta — files unaffected by the delta should NOT appear.
- review_tips: full replacement as plain strings — verification re-runs downstream.
- Mermaid: same rules as the base prompt (TD by default, quoted labels for special chars, no \`\`\`mermaid fences, ASCII arrows only).
- Annotations describe the CHANGE, not the resulting code.

If the delta is trivial (formatting, comments only) you may return an essentially empty patch (no section changes).`;

  const userPrompt = `Update the walkthrough for this PR.

**Title:** ${prData.title}
**Branch:** ${prData.headBranch} → ${prData.baseBranch}
**Stats since previous walkthrough:** ${affectedFiles.length} files changed

**Affected files:**
${affectedFiles.map((f) => `- ${f}`).join("\n")}

<previous_walkthrough>
${JSON.stringify(plainPrev)}
</previous_walkthrough>

**Delta diff (only changes since previous walkthrough):**
\`\`\`diff
${deltaDiff}
\`\`\`

Return ONLY the JSON patch.`;

  log("INFO", `Incremental mode: ${affectedFiles.length} files, ${(deltaDiff.length / 1024).toFixed(1)}KB delta`);

  let response;
  try {
    const stream = client.messages.stream({
      model: GENERATION_MODEL,
      max_tokens: 32000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    let tokenCount = 0;
    stream.on("text", () => {
      tokenCount++;
      if (tokenCount === 1) log("INFO", "First token received, streaming...");
      if (tokenCount % 1000 === 0) log("INFO", `  ...${tokenCount} tokens received`);
    });
    response = await stream.finalMessage();
  } catch (err) {
    log("ERROR", `Incremental API call failed: ${err.message}`);
    throw err;
  }

  log("INFO", `Patch response: ${response.stop_reason}, ${response.usage?.input_tokens} input / ${response.usage?.output_tokens} output tokens`);
  const text = extractText(response);

  // Parse patch JSON with the same resilience as the full path
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || [null, text];
  const jsonStr = jsonMatch[1].trim();
  let patch;
  try {
    patch = JSON.parse(jsonStr);
  } catch (e1) {
    const objMatch = text.match(/\{[\s\S]*\}/);
    const candidate = objMatch ? objMatch[0] : jsonStr;
    patch = tryRepairJSON(candidate);
    if (!patch) {
      const dumpPath = dumpFailedResponse(text, e1);
      log("WARN", `Patch parse failed. Raw response: ${dumpPath}`);
      patch = await repairJSONWithClaude(candidate, client);
    }
    if (!patch) {
      throw new Error(`Failed to parse incremental patch JSON: ${e1.message}`);
    }
  }

  log("INFO", "Applying patch:");
  const merged = applyWalkthroughPatch(previousWalkthrough, patch);

  // Mermaid sanitize + verify tips (same as full path)
  sanitizeWalkthroughDiagrams(merged);
  if (merged.review_tips?.length) {
    const { diff: focusedDiff } = buildFocusedDiff(prData.diff);
    merged.review_tips = await verifyReviewTips(merged.review_tips, focusedDiff, client);
    for (const t of merged.review_tips) {
      if (typeof t === "object" && t.status === "info") t.pending = true;
    }
  }

  return merged;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage:");
    console.log(
      "  node src/generate.js https://github.com/owner/repo/pull/123"
    );
    console.log("  node src/generate.js --local [base-branch]");
    console.log("  node src/generate.js --diff path/to/file.patch");
    console.log("\nFlags:");
    console.log("  --force    Skip cache, regenerate from scratch");
    process.exit(1);
  }

  let prData;

  if (args[0] === "--local") {
    prData = fetchLocalDiff(args[1] || "main");
  } else if (args[0] === "--diff") {
    prData = readDiffFile(args[1]);
  } else {
    prData = await fetchPRData(args[0]);
  }

  if (!prData.diff.trim()) {
    console.error("No diff found. Nothing to walk through.");
    process.exit(1);
  }

  // --- Cache logic ---
  const walkthroughsDir = resolve(__dirname, "..", "public", "walkthroughs");
  if (!existsSync(walkthroughsDir)) {
    mkdirSync(walkthroughsDir, { recursive: true });
  }

  let slug = "walkthrough-data";
  if (prData.owner && prData.repo && prData.number) {
    slug = `${prData.owner}-${prData.repo}-${prData.number}`;
  }
  const perPrPath = resolve(walkthroughsDir, `${slug}.json`);

  let cached = null;
  if (existsSync(perPrPath)) {
    try {
      cached = JSON.parse(readFileSync(perPrPath, "utf-8"));
    } catch {
      log("INFO", "Cached file exists but failed to parse, will regenerate");
    }
  }

  const forceRegenerate = args.includes("--force");
  let walkthrough;

  if (cached && !forceRegenerate && prData.headSha && cached.meta?.headSha === prData.headSha) {
    // Same SHA — reuse walkthrough, just refresh comments/reviews/git history
    console.log(`\n✓ Cache hit — SHA ${prData.headSha.slice(0, 7)} unchanged`);
    console.log("  Refreshing comments and reviews...");
    walkthrough = cached.walkthrough;
  } else if (cached && !forceRegenerate && cached.meta?.headBranch === prData.headBranch) {
    // Same branch, different SHA — try incremental
    const oldShaFull = cached.meta.headSha;
    const newShaFull = prData.headSha;
    const oldSha = (oldShaFull || "unknown").slice(0, 7);
    const newSha = (newShaFull || "unknown").slice(0, 7);

    const deltaDiff = computeDeltaDiff(prData, oldShaFull);
    if (deltaDiff !== null && deltaDiff.trim().length === 0) {
      console.log(`\n✓ Empty delta (${oldSha}..${newSha}) — reusing cached walkthrough`);
      walkthrough = cached.walkthrough;
    } else if (deltaDiff !== null) {
      const affectedFiles = parseDiffIntoFiles(deltaDiff).map((f) => f.path);
      const deltaKB = deltaDiff.length / 1024;
      if (deltaKB <= INCREMENTAL_DELTA_KB_MAX && affectedFiles.length <= INCREMENTAL_AFFECTED_FILES_MAX) {
        console.log(`\n↻ Branch updated (${oldSha} → ${newSha}); ${affectedFiles.length} file(s) changed, ${deltaKB.toFixed(1)}KB delta — incremental mode`);
        try {
          walkthrough = await generateIncrementalWalkthrough(prData, cached.walkthrough, deltaDiff, affectedFiles);
        } catch (err) {
          log("WARN", `Incremental update failed (${err.message}). Falling back to full regen.`);
          walkthrough = await generateWalkthrough(prData, cached.walkthrough);
        }
      } else {
        console.log(`\n↻ Branch updated (${oldSha} → ${newSha}); delta is ${deltaKB.toFixed(1)}KB / ${affectedFiles.length} files (over threshold) — full regen`);
        walkthrough = await generateWalkthrough(prData, cached.walkthrough);
      }
    } else {
      console.log(`\n↻ Branch updated (${oldSha} → ${newSha}), regenerating with previous walkthrough as context...`);
      walkthrough = await generateWalkthrough(prData, cached.walkthrough);
    }
  } else {
    if (cached && forceRegenerate) {
      console.log("\n⟳ --force flag set, regenerating from scratch...");
    }
    walkthrough = await generateWalkthrough(prData);
  }

  // Bundle the walkthrough with the raw diff and PR metadata
  const output = {
    meta: {
      source: prData.source,
      owner: prData.owner || null,
      repo: prData.repo || null,
      number: prData.number || null,
      title: prData.title,
      url: prData.url,
      baseBranch: prData.baseBranch,
      headBranch: prData.headBranch,
      headSha: prData.headSha || null,
      additions: prData.additions,
      deletions: prData.deletions,
      changedFiles: prData.changedFiles,
      generatedAt: new Date().toISOString(),
    },
    walkthrough,
    diff: prData.diff,
    comments: prData.comments || [],
    reviews: prData.reviews || [],
    gitHistory: prData.gitHistory || null,
  };

  // Write to per-PR file
  writeFileSync(perPrPath, JSON.stringify(output, null, 2));

  // Also write to default location for backward compat
  const defaultPath = resolve(__dirname, "..", "public", "walkthrough-data.json");
  writeFileSync(defaultPath, JSON.stringify(output, null, 2));

  console.log(`\nWalkthrough data written to ${perPrPath}`);
  console.log(`Slug: ${slug}`);
  console.log(`Open: http://localhost:5200/?pr=${slug}`);

  // Launch the background resolver for any pending info tips. It will keep
  // running after we exit, updating the JSON as each tip is resolved — the
  // viewer polls and re-renders. Only spawn if there are tips to resolve.
  const pendingCount = (walkthrough.review_tips || []).filter(
    (t) => typeof t === "object" && t.pending
  ).length;
  if (pendingCount > 0 && (process.env.ANTHROPIC_API_KEY || loadEnvKey())) {
    // Use the user's original cwd (where `review` was invoked). bin/review cd's
    // into REVIEW_TOOL_DIR before spawning us but preserves the original here.
    let repoPath = process.env.REVIEW_ORIGINAL_CWD || process.cwd();

    // For URL-based reviews the investigator needs the PR's actual codebase.
    // If the cwd isn't a clone of that repo, shallow-clone it at the PR head
    // into a cache (reused across runs) so tips always get investigated
    // against the real code. For --local and --diff modes, trust the cwd.
    let canResolve = true;
    let skipReason = null;
    if (prData.source === "github" && prData.owner && prData.repo) {
      let cwdMatches = false;
      try {
        const remote = execSync("git config --get remote.origin.url", {
          encoding: "utf-8",
          cwd: repoPath,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        cwdMatches = remote.includes(`${prData.owner}/${prData.repo}`);
      } catch {}
      if (!cwdMatches) {
        try {
          repoPath = ensureRepoClone(prData.owner, prData.repo, prData.number);
        } catch (err) {
          canResolve = false;
          skipReason = `could not clone ${prData.owner}/${prData.repo}: ${err.message}`;
        }
      }
    }

    if (canResolve) {
      const resolverPath = resolve(__dirname, "resolve-info-tips.js");
      const resolverLog = openSync(resolve(__dirname, "..", "logs", `resolver-${slug}.out`), "a");
      const child = spawn(process.execPath, [resolverPath, slug, repoPath], {
        detached: true,
        stdio: ["ignore", resolverLog, resolverLog],
        env: process.env,
      });
      child.unref();
      console.log(`\n⟳ Resolving ${pendingCount} info tip${pendingCount === 1 ? "" : "s"} in the background (pid ${child.pid})`);
      console.log(`  Investigating repo at: ${repoPath}`);
      console.log(`  The viewer will update automatically as results arrive.`);
    } else {
      // Clear the pending flags so the viewer doesn't spin forever.
      const walkthroughContent = JSON.parse(readFileSync(perPrPath, "utf-8"));
      for (const t of walkthroughContent.walkthrough.review_tips || []) {
        if (t.pending) delete t.pending;
      }
      writeFileSync(perPrPath, JSON.stringify(walkthroughContent, null, 2));
      writeFileSync(defaultPath, JSON.stringify(walkthroughContent, null, 2));
      console.log(`\nℹ Skipping background info-tip resolution: ${skipReason}.`);
      console.log(`  Check network/gh auth, or re-run from a local clone of the PR's repo.`);
    }
  }
}

main().catch((err) => {
  log("ERROR", `\nFailed: ${err.message}`);
  if (err.stack) {
    appendFileSync(LOG_FILE, `\nStack trace:\n${err.stack}\n`);
  }
  if (err.status) {
    log("ERROR", `HTTP status: ${err.status}`);
  }
  if (err.headers) {
    const interesting = ["retry-after", "x-request-id", "x-should-retry", "cf-ray"];
    const found = interesting
      .filter((h) => err.headers?.[h])
      .map((h) => `${h}: ${err.headers[h]}`);
    if (found.length) {
      appendFileSync(LOG_FILE, `\nResponse headers: ${found.join(", ")}\n`);
    }
  }
  if (err.error) {
    appendFileSync(LOG_FILE, `\nAPI error body:\n${JSON.stringify(err.error, null, 2)}\n`);
  }
  if (err instanceof APIConnectionError) {
    console.error("Hint: This is a network-level failure. Check your internet connection or try again.");
  }
  console.error(`\nLog file: ${LOG_FILE}`);
  process.exit(1);
});
