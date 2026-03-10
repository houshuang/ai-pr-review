/**
 * Generate a walkthrough JSON from a GitHub PR or local git diff.
 *
 * Usage:
 *   node src/generate.js https://github.com/owner/repo/pull/123
 *   node src/generate.js --local [base-branch]
 *   node src/generate.js --diff path/to/diff.patch
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from ~/src/alif/.env
function loadEnvKey() {
  const envPath = resolve(process.env.HOME, "src/alif/.env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^ANTHROPIC_KEY=(.+)$/);
      if (match) return match[1].trim();
    }
  }
  return process.env.ANTHROPIC_API_KEY;
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

  return {
    source: "github",
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

The output must be valid JSON matching this schema:

{
  "title": "string - concise walkthrough title",
  "subtitle": "string - one sentence summary of what this PR does",
  "overview": "string - 2-3 paragraph overview in markdown explaining the big picture",
  "architecture_diagram": "string - a mermaid.js diagram showing the high-level architecture or data flow of the changes (use flowchart TD or LR). Keep it focused on what changed.",
  "sections": [
    {
      "id": "string - kebab-case identifier",
      "title": "string - section heading",
      "narrative": "string - markdown explanation of this group of changes. Explain WHY these changes matter, how they connect, and what patterns they establish. Be pedagogical.",
      "diagram": "string|null - optional mermaid.js diagram for this section",
      "hunks": [
        {
          "file": "string - file path",
          "startLine": number,
          "endLine": number,
          "annotation": "string - brief explanation of what this specific code does and WHY it's designed this way",
          "importance": "critical|important|supporting|context"
        }
      ],
      "callouts": [
        {
          "type": "insight|warning|pattern|tradeoff",
          "label": "string - short label",
          "text": "string - explanation"
        }
      ]
    }
  ],
  "file_map": [
    {
      "path": "string",
      "description": "string - what this file does in the PR",
      "is_new": boolean
    }
  ],
  "review_tips": ["string - specific things the reviewer should pay attention to"]
}

Guidelines:
- Group related changes across files into logical sections. A section might span 2-5 files.
- Order sections for progressive understanding: start with types/interfaces, then core logic, then wiring, then UI.
- Every hunk must reference real file paths and line ranges from the diff.
- For importance: "critical" = must review carefully (core logic, security), "important" = should review (key behavior), "supporting" = skim-worthy (boilerplate, config), "context" = unchanged code shown for understanding.
- The narrative should read like a teaching document, not a changelog.
- Include mermaid diagrams where they help visualize flow or architecture.
- Be opinionated about tradeoffs - explain what alternatives existed.
- Keep annotations concise but insightful. Focus on WHY, not WHAT (the code shows WHAT).
- If the diff is large, prioritize depth on critical sections over exhaustive coverage of boilerplate.`;

async function generateWalkthrough(prData) {
  const apiKey = loadEnvKey();
  if (!apiKey) {
    throw new Error(
      "No Anthropic API key found. Set ANTHROPIC_API_KEY or add ANTHROPIC_KEY to ~/src/alif/.env"
    );
  }

  const client = new Anthropic({ apiKey });

  const userPrompt = `Here is the PR to create a walkthrough for:

**Title:** ${prData.title}
**Branch:** ${prData.headBranch} → ${prData.baseBranch}
**Stats:** +${prData.additions} -${prData.deletions} across ${prData.changedFiles} files
${prData.url ? `**URL:** ${prData.url}` : ""}
${prData.body ? `\n**Description:**\n${prData.body}` : ""}

**Full Diff:**
\`\`\`diff
${prData.diff}
\`\`\`

Generate the walkthrough JSON. Remember: every hunk must reference real files and line numbers from the diff above.`;

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
  };

  const outPath = resolve(__dirname, "..", "public", "walkthrough-data.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWalkthrough data written to ${outPath}`);
  console.log("Run 'pnpm dev' to view the interactive review.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
