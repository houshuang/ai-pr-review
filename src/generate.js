/**
 * Generate a walkthrough JSON from a GitHub PR or local git diff.
 *
 * Usage:
 *   node src/generate.js https://github.com/owner/repo/pull/123
 *   node src/generate.js --local [base-branch]
 *   node src/generate.js --diff path/to/diff.patch
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // Check for .env file in project root
  const localEnv = resolve(__dirname, "..", ".env");
  if (existsSync(localEnv)) {
    const lines = readFileSync(localEnv, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^ANTHROPIC_API_KEY=(.+)$/);
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
    `gh pr view ${number} --repo ${owner}/${repo} --json title,body,url,baseRefName,headRefName,additions,deletions,changedFiles,commits,files`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
  );
  const pr = JSON.parse(prJson);

  // Fetch the full diff
  const diff = execSync(
    `gh pr diff ${number} --repo ${owner}/${repo}`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
  );

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

async function generateWalkthrough(prData) {
  const apiKey = loadEnvKey();
  if (!apiKey) {
    throw new Error(
      "No Anthropic API key found. Set ANTHROPIC_API_KEY env var or add ANTHROPIC_API_KEY=... to .env in project root"
    );
  }

  const client = new Anthropic({ apiKey });

  const userPrompt = `Create a walkthrough for this PR.

**Title:** ${prData.title}
**Branch:** ${prData.headBranch} → ${prData.baseBranch}
**Stats:** +${prData.additions} -${prData.deletions} across ${prData.changedFiles} files
${prData.url ? `**URL:** ${prData.url}` : ""}
${prData.body ? `\n**PR Description:**\n${prData.body}` : ""}
${prData.comments?.length ? `\n**Existing Review Comments (${prData.comments.length}):**\n${prData.comments.map((c) => `- ${c.user} on ${c.path}:${c.line}: ${c.body.substring(0, 200)}`).join("\n")}` : ""}
${prData.reviews?.length ? `\n**Reviews:** ${prData.reviews.map((r) => `${r.user}: ${r.state}`).join(", ")}` : ""}
${formatGitHistoryForPrompt(prData.gitHistory)}
**Full Diff:**
\`\`\`diff
${prData.diff}
\`\`\`

Generate the walkthrough JSON. Important reminders:
- Every hunk must reference real file paths and line numbers from the diff above
- Annotations should describe the CHANGE (what was different before), not just describe the resulting code
- Mermaid diagrams: raw mermaid syntax only, do NOT wrap in \`\`\`mermaid code fences
- file_map must include every file in the diff`;

  console.log("Sending to Claude API...");
  console.log(`Diff size: ${(prData.diff.length / 1024).toFixed(1)}KB`);

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content[0].text;

  // Extract JSON from the response (it might be wrapped in ```json blocks)
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || [null, text];
  const jsonStr = jsonMatch[1].trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    // Try to find JSON object in the response
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      return JSON.parse(objMatch[0]);
    }
    throw new Error("Failed to parse walkthrough JSON from Claude response");
  }
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

  const walkthrough = await generateWalkthrough(prData);

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

  // Write to per-PR file if GitHub PR, otherwise default
  const walkthroughsDir = resolve(__dirname, "..", "public", "walkthroughs");
  if (!existsSync(walkthroughsDir)) {
    mkdirSync(walkthroughsDir, { recursive: true });
  }

  let slug = "walkthrough-data";
  if (prData.owner && prData.repo && prData.number) {
    slug = `${prData.owner}-${prData.repo}-${prData.number}`;
  }
  const perPrPath = resolve(walkthroughsDir, `${slug}.json`);
  writeFileSync(perPrPath, JSON.stringify(output, null, 2));

  // Also write to default location for backward compat
  const defaultPath = resolve(__dirname, "..", "public", "walkthrough-data.json");
  writeFileSync(defaultPath, JSON.stringify(output, null, 2));

  console.log(`\nWalkthrough data written to ${perPrPath}`);
  console.log(`Slug: ${slug}`);
  console.log(`Open: http://localhost:5200/?pr=${slug}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
