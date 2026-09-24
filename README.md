# AI PR Review

An AI-powered code review tool that turns pull requests into interactive, narrated walkthroughs. Instead of reading diffs top-to-bottom, you get a structured explanation of *what changed* and *why* — with architecture diagrams, annotated code, and the ability to ask questions about any section.

<img width="1719" height="1293" alt="image" src="https://github.com/user-attachments/assets/ff72942f-5739-4211-b7a8-83a5cca06427" />

<img width="1717" height="1293" alt="image" src="https://github.com/user-attachments/assets/1d21de8f-ff7b-48dc-ac85-836ac8a8a915" />

## The problem

Reading a 30-file PR is hard. You see lines added and removed, but not the *story* — which changes are foundational, which are mechanical follow-through, and how the pieces connect. Good PR authors write descriptions, but the description and the diff are separate experiences.

This tool bridges them. It uses Claude or Codex, whichever you choose, to analyze the full PR — diffs, commit history, file ages, existing review comments — and produces a structured walkthrough that sequences the changes for progressive understanding. The walkthrough is rendered as an interactive review UI where you can read the narrative, inspect the diffs, post comments, and submit your review — all in one place.

## Quick start

```bash
git clone https://github.com/houshuang/ai-pr-review.git
cd ai-pr-review
pnpm install
cp .env.example .env   # for Claude: put your Anthropic API key in .env

# Review any GitHub PR you can read with `gh`
./bin/review https://github.com/owner/repo/pull/123
```

The first run asks whether Claude or Codex should generate walkthroughs by default and saves the answer (see [Choosing the AI provider](#choosing-the-ai-provider)). It then fetches the PR, generates the walkthrough, starts a local viewer on http://localhost:5200 and opens it in your browser. Generation takes about a minute for a small PR and several minutes for a large one; later runs on the same commit reuse the cached walkthrough.

### Requirements

- macOS or Linux (the CLI is a bash script)
- Node.js 20+, pnpm (10 or 11)
- [GitHub CLI](https://cli.github.com/) (`gh auth login`)
- At least one provider:
  - Claude: an Anthropic API key (`export ANTHROPIC_API_KEY=sk-ant-...` or add it to `.env`)
  - Codex: the [Codex CLI](https://github.com/openai/codex), installed and logged in (`codex login`)

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
                    │   Claude or Codex   │
                    │                     │
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

**Generator** (`src/generate.js`) — Fetches everything about the PR via `gh` CLI (diff, commits, file ages, churn, existing comments — all fetched concurrently), builds a rich context, and sends it to Codex or Claude with a detailed prompt. The AI returns structured JSON: narrative sections with annotated code hunks, importance ratings, architecture diagrams, and review tips. The Claude path uses streaming, TCP keepalives, a 15-minute timeout, and 3 automatic retries.

**Viewer** (Preact SPA) — Renders the walkthrough as an interactive review UI. Diffs are syntax-highlighted and filtered to show only the relevant hunks per section. The Vite dev server proxies GitHub API calls through `gh`, so posting comments and submitting reviews works without managing tokens.

**AI Chat** — Each section has a chat assistant that answers questions about the code changes, using the provider that generated the walkthrough. The dev server sends it the PR title and overview, the section's narrative, annotations and callouts, and the conversation so far; it does not read the rest of the codebase (the background tip investigation below does).

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
- **Inline annotations** placed at natural block boundaries (after the last changed line in each diff block, not mid-context), styled with importance-colored accent borders and line-range badges; side-by-side mode keeps both panes vertically aligned
- **Clickable file references** — `file.ts:42` references in narratives and annotations scroll to the relevant diff line
- **Context expansion** — click to load surrounding lines (fetched from GitHub)
- **Importance levels** — critical, important, supporting, context — so you know what to scrutinize
- **Stale review detection** — banner warns when the PR has new commits since the walkthrough was generated, listing each new commit (SHA, message, author) and the +/-/file totals so you can decide whether a re-run is worth it. The generator also re-checks the head SHA after fetching the diff and warns if the PR was updated mid-fetch
- **Complete coverage** — every file in the PR appears, either in narrative sections or in "Remaining Changes"

### GitHub integration

- **Post line comments** — select a line or range, write your comment, post directly
- **Submit reviews** — approve, request changes, or comment from a modal
- **Existing comments** — threaded inline at the relevant code

### Navigation and progress

- **Keyboard-driven** — `j`/`k` navigate sections, `r` marks reviewed, `n` jumps to next unreviewed, `1`-`6` switch views, `?` shows all shortcuts
- **Review progress** — track which sections and files you've reviewed
- **Architecture diagrams** — auto-generated Mermaid diagrams showing the structural changes; diagrams are auto-sanitized at generation and render time (pipes, angle brackets, quotes in labels, inner quotes in already-quoted labels) with parse-validate → sanitize → retry logic. Click any diagram to open it in a full-screen pan/zoom overlay (wheel to zoom, drag to pan, double-click to reset, Esc to close)
- **Dark mode** — respects OS preference, toggle with `d`. Full dark theme across all views and diff rendering.

### AI chat

Select code in a diff and click **"Ask AI"** (or press `a`) to ask questions about any section. The chat uses the walkthrough's selected provider with the section narrative, code annotations, and callouts as context. Example questions: "What happens if this check fails?", "Why was this approach chosen over X?"

### Smart generation

- **Large PR handling** — Prioritizes modified/deleted files (they touch existing code), includes smaller new files in full, summarizes large new files
- **Incremental updates** — When a branch gets new commits, the generator computes the delta diff between the cached head SHA and the new head SHA. Empty delta (force-push of identical content) reuses the cached walkthrough verbatim. Small delta (≤30KB and ≤8 affected files) runs **patch mode**: the selected provider receives only the delta plus the previous walkthrough and returns a JSON patch (`updated_sections`, `added_sections`, `removed_section_ids`, `file_map_changes`, `review_tips`) which is merged programmatically. Larger deltas fall back to full regeneration. Patch-mode failures fall back to full regen automatically
- **SHA-based caching** — Same SHA = instant reuse, just refreshes comments and reviews
- **Resilient AI calls** — Claude: streaming responses, TCP keepalive (undici Agent), 15-minute timeout, 3 retries with exponential backoff. Codex: prompt over stdin, 15-minute timeout, the CLI's own error message reported with a fix hint (upgrade, `codex login`, unsupported model). Diagnostics and token counts for both go to `logs/`
- **Resilient JSON parsing** — if the AI returns malformed JSON, the full response is dumped to `logs/failed-response-<timestamp>.txt` and a two-stage repair pipeline runs (local position-based escape pass, then an AI "fix syntax only" fallback) before the run is failed
- **Verified review tips** — The AI generates review concerns during the walkthrough; a detached background process (`src/resolve-info-tips.js`) then verifies them so the viewer opens immediately after generation, with spinners on pending tips. Stage 1 classifies every tip against the diff as `verified` (✓, addressed), `concern` (⚠, real issue), or `info` (ℹ, can't tell from diff alone)
- **Background investigation of info tips** — Stage 2 investigates tips the diff couldn't settle in the actual codebase using the selected provider's read-only tools. The viewer polls the JSON every 4s, auto-updating as each tip resolves with specific `file:line` findings. For URL-based reviews, if the invoking directory isn't a clone of the PR's repo, the resolver shallow-clones the repo at the PR head into `.cache/repos/` (cached across runs) so tips are always investigated against the real code; `--local`/`--diff` mode uses the invoking directory
- **Hot-loaded walkthroughs** — The dev server reads `public/walkthroughs/*.json` from disk on every request via a custom Vite middleware, so newly generated walkthroughs are picked up without restarting `pnpm dev`

## Usage

### From a GitHub PR

```bash
# One command — generates, starts server, opens browser
./bin/review https://github.com/owner/repo/pull/123

# Force regeneration (skip cache)
./bin/review https://github.com/owner/repo/pull/123 --force

# Use a specific provider for this run only
./bin/review https://github.com/owner/repo/pull/123 --claude
./bin/review https://github.com/owner/repo/pull/123 --codex
```

### From a branch name

Paste just the branch and the PR is looked up for you — first in the repo you're
standing in, then in the repos most recently walked through, then a global
GitHub PR search:

```bash
./bin/review sh/my-feature
# ✓ sh/my-feature → owner/repo#123 (open) — Add the thing
```

Open PRs win over merged/closed ones; if several PRs share the branch name the
rest are printed so you can rerun with an explicit URL.

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

### Open the viewer without generating

```bash
# Starts the viewer on the walkthroughs already in public/walkthroughs/
./bin/review
```

### Export static HTML

```bash
# Export a previously generated walkthrough as a self-contained HTML file
./bin/review --export owner-repo-123

# Choose the output path and diff mode
./bin/review --export owner-repo-123 --output review.html --mode unified
```

The slug is printed at the end of generation (`Slug: owner-repo-123`). You can also press `p` in the viewer to export.

## Choosing the AI provider

Walkthrough generation, tip verification and investigation, and section chat all run on one provider:

- **Claude** — the Anthropic API, billed to your API key.
- **Codex** — the Codex CLI in a read-only, ephemeral sandbox, on whatever account `codex login` uses.

The first time `review` generates a walkthrough it asks which one to use by default and saves the answer to `${XDG_CONFIG_HOME:-~/.config}/ai-pr-review/config.json`. Every run prints one line saying which provider it is using and how to change it.

```bash
./bin/review --set-default claude   # change the saved default
./bin/review <PR url> --codex       # override it for one run
REVIEW_AI_PROVIDER=codex ./bin/review <PR url>   # override it from the environment
```

A flag beats `REVIEW_AI_PROVIDER`, which beats the saved default. When no default is saved and there is no terminal to ask (CI, scripts, `node src/generate.js`), the tool uses Claude if an Anthropic key is available, otherwise Codex if the `codex` CLI is on `PATH`, and otherwise stops with an error. Nothing is saved in that case.

A walkthrough records the provider that generated it: its chat uses the same provider, and regenerating with a different provider starts from scratch instead of patching the cached walkthrough.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key, needed for Claude | — |
| `REVIEW_AI_PROVIDER` | `claude` or `codex`; overrides the saved default | saved default |
| `REVIEW_MODEL` | Claude model for generation, tip investigation, and chat (e.g. `claude-sonnet-5` for cheaper runs) | `claude-opus-5-5` |
| `REVIEW_CODEX_MODEL` | Codex model override | Codex CLI config |
| `REVIEW_PORT` | Dev server port | `5200` |

For Claude, copy `.env.example` to `.env` and add your key, or set it as an environment variable. Only the key is read from `.env`; the other variables come from the shell environment.

Generating a walkthrough makes one AI call, then a background pass that verifies the review tips (and investigates those the diff cannot settle). Reusing a cached walkthrough, or just opening the viewer, makes no AI calls; chat makes one per message. Walkthroughs, the repo clones used for tip investigation (`.cache/`) and logs (`logs/`) stay on your machine.

## Project structure

```
bin/review              CLI entry point (bash)
src/
  generate.js           Walkthrough generator — fetches PR data, calls the selected AI
  ai-provider.js        Codex CLI runner shared by generation, tips and chat
  provider-config.js    Provider choice: flags, env, saved default, first-run prompt
  resolve-branch.js     Resolves a bare branch name to its PR
  resolve-info-tips.js  Background resolver — investigates unresolved review tips
                        in the target repo using read-only AI tools, rewrites JSON
                        in place as each tip resolves
  export-static.js      Static HTML export
  app.jsx               Preact entry point
  state.js              Reactive state management (Preact Signals)
  api.js                GitHub API integration (comments, reviews, context)
  diff.js               Diff parsing and filtering
  keyboard.js           Keyboard shortcuts
  mermaid.js            Diagram rendering + click-to-zoom overlay
  mermaid-sanitize.js   Pre-render sanitization for common LLM mermaid mistakes
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
