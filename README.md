# AI PR Review

An AI-powered code review tool that turns pull requests into interactive, narrated walkthroughs. Instead of reading diffs top-to-bottom, you get a structured explanation of *what changed* and *why* — with architecture diagrams, annotated code, and the ability to ask questions about any section.

<img width="1719" height="1293" alt="image" src="https://github.com/user-attachments/assets/ff72942f-5739-4211-b7a8-83a5cca06427" />

<img width="1717" height="1293" alt="image" src="https://github.com/user-attachments/assets/1d21de8f-ff7b-48dc-ac85-836ac8a8a915" />

## The problem

Reading a 30-file PR is hard. You see lines added and removed, but not the *story* — which changes are foundational, which are mechanical follow-through, and how the pieces connect. Good PR authors write descriptions, but the description and the diff are separate experiences.

This tool bridges them. It uses Claude to analyze the full PR — diffs, commit history, file ages, existing review comments — and produces a structured walkthrough that sequences the changes for progressive understanding. Then it renders that walkthrough as an interactive review UI where you can read the narrative, inspect the diffs, post comments, and submit your review — all in one place.

## Quick start

```bash
git clone https://github.com/houshuang/ai-pr-review.git
cd ai-pr-review
pnpm install

# Review any GitHub PR
./bin/review https://github.com/owner/repo/pull/123
```

This fetches the PR, generates a walkthrough with Claude, and opens it in your browser.

### Requirements

- Node.js 18+, pnpm
- [GitHub CLI](https://cli.github.com/) (`gh auth login`)
- Anthropic API key (`export ANTHROPIC_API_KEY=sk-ant-...` or add to `.env`)

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│                         review <PR url>                         │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   GitHub CLI (gh)    │
                    │                     │
                    │  PR metadata        │
                    │  Full diff          │
                    │  Review comments    │
                    │  Commit history     │
                    │  File ages & churn  │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Claude API        │
                    │                     │
                    │  Structured JSON    │
                    │  walkthrough with   │
                    │  sections, hunks,   │
                    │  annotations,       │
                    │  diagrams           │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Preact SPA        │
                    │                     │
                    │  Interactive review │
                    │  UI with diffs,     │
                    │  comments, chat,    │
                    │  progress tracking  │
                    └─────────────────────┘
```

**Generator** (`src/generate.js`) — Fetches everything about the PR via `gh` CLI, builds a rich context (diff, commits, file ages, churn, existing comments), and sends it to Claude with a detailed prompt. Claude returns structured JSON: narrative sections with annotated code hunks, importance ratings, architecture diagrams, and review tips. The API call uses a 15-minute timeout with 3 automatic retries (exponential backoff) for connection errors, rate limits, and server errors.

**Viewer** (Preact SPA) — Renders the walkthrough as an interactive review UI. Diffs are syntax-highlighted and filtered to show only the relevant hunks per section. The Vite dev server proxies GitHub API calls through `gh`, so posting comments and submitting reviews works without managing tokens.

**AI Chat** — Each section has a chat assistant (powered by Claude Code CLI) that can answer questions about the code changes. It has read access to the actual codebase, so it can look up context, check git history, and give informed answers.

## Features

### Six view layouts

| Layout | Best for |
|--------|----------|
| **Editorial** | Default reading flow — narrative sections with inline diffs |
| **Sidebar** | Side-by-side TOC navigation |
| **Focus** | Step-through one section at a time |
| **Split** | Narrative on the left, diff on the right |
| **Developer** | Dense, code-first view |
| **Dashboard** | Card grid overview of all sections |

### Code review

- **Syntax-highlighted diffs** with inline AI annotations at the relevant code lines
- **Side-by-side and unified** diff views (toggle with `s` / `u`); new files auto-switch to unified to avoid a blank left pane
- **Inline annotations** styled with importance-colored accent borders and line-range badges for clear visual hierarchy
- **Clickable file references** — `file.ts:42` references in narratives and annotations scroll to the relevant diff line
- **Context expansion** — click to load surrounding lines (fetched from GitHub)
- **Importance levels** — critical, important, supporting, context — so you know what to scrutinize
- **Stale review detection** — banner warns when the PR has new commits since the walkthrough was generated
- **Complete coverage** — every file in the PR appears, either in narrative sections or in "Remaining Changes"

### GitHub integration

- **Post line comments** — select a line or range, write your comment, post directly
- **Submit reviews** — approve, request changes, or comment from a modal
- **Existing comments** — threaded inline at the relevant code

### Navigation and progress

- **Keyboard-driven** — `j`/`k` navigate sections, `r` marks reviewed, `n` jumps to next unreviewed, `1`-`6` switch views, `?` shows all shortcuts
- **Review progress** — track which sections and files you've reviewed
- **Architecture diagrams** — auto-generated Mermaid diagrams showing the structural changes
- **Dark mode** — respects OS preference, toggle with `d`. Full dark theme across all views and diff rendering.

### AI chat

Select code in a diff and click **"Ask AI"** (or press `a`) to ask questions about any section. The chat uses the Anthropic API with the section's narrative, code annotations, and callouts as context — responses stream in ~2-3 seconds. Example questions: "What happens if this check fails?", "Why was this approach chosen over X?"

### Smart generation

- **Large PR handling** — Prioritizes modified/deleted files (they touch existing code), includes smaller new files in full, summarizes large new files
- **Incremental updates** — When a branch gets new commits, the previous walkthrough is sent as context for a faster, structure-preserving update
- **SHA-based caching** — Same SHA = instant reuse, just refreshes comments and reviews
- **Resilient API calls** — 15-minute timeout, 3 retries with exponential backoff, detailed error diagnostics logged to `logs/`

## Usage

### From a GitHub PR

```bash
# One command — generates, starts server, opens browser
./bin/review https://github.com/owner/repo/pull/123

# Force regeneration (skip cache)
./bin/review https://github.com/owner/repo/pull/123 --force
```

### From a local branch

```bash
# Compare current branch against main
./bin/review --local

# Compare against a specific base branch
./bin/review --local develop
```

### From a patch file

```bash
./bin/review --diff path/to/changes.patch
```

### Export static HTML

```bash
# Export a previously generated walkthrough as a self-contained HTML file
./bin/review --export owner-repo-123
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (required) | — |
| `REVIEW_PORT` | Dev server port | `5200` |

Copy `.env.example` to `.env` and add your key, or set it as an environment variable.

## Project structure

```
bin/review              CLI entry point (bash)
src/
  generate.js           Walkthrough generator — fetches PR data, calls Claude API
  export-static.js      Static HTML export
  app.jsx               Preact entry point
  state.js              Reactive state management (Preact Signals)
  api.js                GitHub API integration (comments, reviews, context)
  diff.js               Diff parsing and filtering
  keyboard.js           Keyboard shortcuts
  mermaid.js            Diagram rendering
  utils.js              Shared utilities
  styles.css            All styles
  components/
    App.jsx             Main app controller
    ChatThread.jsx      AI chat assistant per section
    Section.jsx         Narrative section with collapse/review
    HunkGroup.jsx       File hunks with annotations
    DiffView.jsx        Syntax-highlighted diff rendering
    CommentComposer.jsx Inline comment composer
    ReviewModal.jsx     Approve/request changes dialog
    Header.jsx          PR metadata and reviewers
    Landing.jsx         Entry page for loading PRs
    Overview.jsx        Architecture diagram and summary
    TOC.jsx             Table of contents
    ...                 15+ more components
    layouts/            6 view layout implementations
vite.config.js          Vite config + gh API proxy + chat middleware
```

## License

MIT
