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
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { sanitizeWalkthroughDiagrams } from "./mermaid-sanitize.js";
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
  "architecture_diagram": "string - mermaid.js diagram (flowchart TD or LR) showing the structural change. Show before→after or the new data/control flow. Do NOT just draw boxes for each file.",
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
      model: "claude-sonnet-4-6",
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
  const text = response.content[0].text;

  // Extract JSON from the response (it might be wrapped in ```json blocks)
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || [null, text];
  const jsonStr = jsonMatch[1].trim();

  let walkthrough;
  try {
    walkthrough = JSON.parse(jsonStr);
  } catch {
    // Try to find JSON object in the response
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      walkthrough = JSON.parse(objMatch[0]);
    } else {
      throw new Error("Failed to parse walkthrough JSON from Claude response");
    }
  }

  // Fix common Mermaid syntax issues (e.g. unquoted pipes in node labels)
  sanitizeWalkthroughDiagrams(walkthrough);
  return walkthrough;
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
    // Same branch, different SHA — incremental update
    const oldSha = (cached.meta.headSha || "unknown").slice(0, 7);
    const newSha = (prData.headSha || "unknown").slice(0, 7);
    console.log(`\n↻ Branch updated (${oldSha} → ${newSha}), regenerating with previous walkthrough as context...`);
    walkthrough = await generateWalkthrough(prData, cached.walkthrough);
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
