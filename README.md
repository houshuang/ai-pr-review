# AI PR Review Tool

An AI-powered interactive PR walkthrough generator and reviewer. Uses Claude to analyze pull requests and generate structured, narrative walkthroughs with inline code annotations — then presents them in an interactive web UI for reviewing.

## What it does

1. **Generates** a structured walkthrough from a GitHub PR (or local diff) using Claude
2. **Renders** it as an interactive web app with syntax-highlighted diffs, inline annotations, architecture diagrams, and review progress tracking
3. **Integrates** with GitHub — post line comments, approve or request changes, all from the review UI

## Prerequisites

- **Node.js** 18+
- **pnpm** (or npm/yarn)
- **GitHub CLI** (`gh`) — authenticated with `gh auth login`
- **Anthropic API key** — set as `ANTHROPIC_API_KEY` environment variable or in a `.env` file in the project root

### Install prerequisites

```bash
# Install GitHub CLI (macOS)
brew install gh
gh auth login

# Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...
# Or create a .env file in the project root:
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
```

## Installation

```bash
git clone https://github.com/houshuang/ai-pr-review.git
cd ai-pr-review
pnpm install
```

## Usage

### Quick start — review a PR

```bash
./bin/review https://github.com/owner/repo/pull/123
```

This will:
1. Fetch the PR data from GitHub
2. Generate a walkthrough using Claude
3. Start the dev server
4. Open the review UI in your browser

### Step by step

```bash
# Generate a walkthrough
pnpm generate https://github.com/owner/repo/pull/123

# Start the dev server
pnpm dev --port 5200

# Open in browser (the slug is printed by the generate command)
# http://localhost:5200/?pr=owner-repo-123
```

### From a local diff

```bash
# Compare current branch against main
pnpm generate --local

# Compare against a specific base branch
pnpm generate --local develop
```

### From a patch file

```bash
pnpm generate --diff path/to/changes.patch
```

## Features

- **6 view layouts**: Editorial, Sidebar, Focus (step-by-step), Split, Developer, Dashboard
- **Syntax-highlighted diffs** with inline AI annotations placed at the relevant code lines
- **Side-by-side and unified** diff views
- **Architecture diagrams** (Mermaid) auto-generated from the PR
- **Review progress tracking** — mark sections and files as reviewed
- **GitHub integration** — post line comments (single line or ranges), approve/request changes
- **Keyboard shortcuts** — `j`/`k` navigate, `r` marks reviewed, `n` jumps to next unreviewed, `?` for help
- **Dark mode**
- **Context expansion** — click to load more lines around a diff hunk (fetched from GitHub)

## Configuration

| Environment variable | Description | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (required for generation) | — |
| `REVIEW_PORT` | Dev server port | `5200` |

You can also place a `.env` file in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
```

## How it works

The **generator** (`src/generate.js`) fetches PR metadata, diffs, review comments, commit history, and file ages via the `gh` CLI. It sends all of this to Claude with a detailed prompt that produces a structured JSON walkthrough — organized into narrative sections, each referencing specific code hunks with importance ratings and annotations.

The **viewer** (Preact SPA) renders this JSON as an interactive review UI. Diffs are rendered with diff2html and post-processed to add syntax highlighting (via highlight.js) and inject annotations inline at the referenced code lines. The Vite dev server proxies GitHub API calls through the `gh` CLI, so posting comments and submitting reviews works without managing tokens.

## Project structure

```
bin/review          CLI entry point
src/generate.js     Walkthrough generator (calls gh + Claude API)
src/app.jsx         Preact app entry point
src/components/     UI components (App, DiffView, HunkGroup, etc.)
src/api.js          GitHub API integration (comments, reviews, context)
src/diff.js         Diff parsing and filtering
src/state.js        Reactive state (Preact Signals)
src/styles.css      All styles
src/mermaid.js      Mermaid diagram rendering
src/keyboard.js     Keyboard shortcut handling
src/utils.js        Shared utilities
vite.config.js      Vite config + gh API proxy middleware
```

## License

MIT
