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

The first run asks whether Claude or Codex should generate walkthroughs by default and saves the answer (see [Choosing the AI provider](#choosing-the-ai-provider)). It then fetches the PR, generates the walkthrough, starts a local viewer on http://localhost:5200 and opens it in your browser. Generation time depends on the model and PR size. Later runs reuse the walkthrough when its input, revision and model configuration match the cache.

### Requirements

- macOS or Linux (the CLI is a bash script)
- Node.js 20+, pnpm (10 or 11)
- [GitHub CLI](https://cli.github.com/) (`gh auth login`)
- At least one provider:
  - Claude: an Anthropic API key (`export ANTHROPIC_API_KEY=sk-ant-...` or add it to `.env`)
  - Codex: the [Codex CLI](https://github.com/openai/codex), installed and logged in (`codex login`). It is required for automatic review-tip checks, including Claude-generated walkthroughs. Use a current CLI with `--ignore-user-config`, `--output-schema` and the feature flags described below.

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

**Generator** (`src/generate.js`) — Fetches PR metadata, the diff, commit history, file ages, churn and existing comments via `gh`. It checks the base and head revisions again after fetching the diff, retrying if either moved. Codex or Claude produces structured JSON: narrative sections with annotated code hunks, importance ratings, architecture diagrams and review tips. Schema and semantic validation check section identifiers and diff references before publication; file coverage is derived from the actual diff. The Claude path uses streaming, TCP keepalives, a 15-minute timeout and automatic retries.

**Viewer** (Preact SPA) — Renders the walkthrough as an interactive review UI. Diffs are syntax-highlighted and filtered to show the relevant hunks per section. The Vite dev server proxies supported GitHub API calls through `gh`, so posting comments and submitting reviews works without managing tokens. Local endpoints validate origins, request sizes and allowed operations; GitHub commands run asynchronously without a shell.

**AI Chat** — Each section has a chat assistant using the provider that generated the walkthrough. The server loads the stored walkthrough by slug and generation identity, then supplies the section's narrative, annotations, callouts and actual diff hunks with old/new line numbers. Stale chats are rejected so a newer review cannot silently change their context. Chat sees those hunks and their existing diff context; the background tip checks can inspect the full repository.

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
- **Stale review detection** — banner warns when the PR has new commits since the walkthrough was generated, listing each new commit (SHA, message, author) and the +/-/file totals so you can decide whether a re-run is worth it. The generator re-checks both base and head after fetching the diff, retries a moving revision up to three times, and fails if it cannot establish a stable snapshot
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

Select code in a diff and click **"Ask AI"** (or press `a`) to ask questions about any section. The chat uses the walkthrough's selected provider with the stored section narrative, annotations, callouts and actual diff code as context. Example questions: "What happens if this check fails?", "Why was this approach chosen over X?"

### Smart generation

- **Large PR handling** — Prioritizes modified/deleted files, includes smaller new files in full and summarizes large new files. File size alone does not classify code as generated. When GitHub cannot serve a large diff, the fallback reads a pinned repository snapshot without fetching into your working checkout.
- **Incremental updates** — A new head on the same branch and base can use a delta against the cached head. For GitHub reviews, only a linear advance is eligible; a rewind or divergent force-push triggers full generation. A small delta (≤30KB and ≤8 affected files) uses **patch mode**: the provider returns section, file-map and tip changes which are merged and validated against the current full diff. An eligible empty delta reuses the narrative. Larger deltas, unavailable comparisons and invalid patches fall back to full generation.
- **Input-aware caching** — Reuse requires matching input, source provenance, base/head revisions, provider, task model/effort settings and prompt version. Title/body changes also invalidate the cache. Cache hits retain their generation identity and original generation time while refreshing comments and reviews; old caches lacking this metadata regenerate once. `--force` always creates a new generation.
- **Validated output** — Both providers receive JSON schemas. Local validation rejects duplicate section IDs and references outside the reviewed diff, including checking deleted files against old-side line numbers. Remaining file coverage is derived from the diff rather than trusted to the model. Syntax repair tries a local escape pass, then an AI repair task; failed responses are saved under `logs/`.
- **Resilient AI calls** — Claude uses streaming, TCP keepalive, a 15-minute timeout and retries with exponential backoff. Codex reads prompts over stdin, parses JSONL events incrementally, bounds diagnostic output, reports failed turns even when the CLI exits successfully, and terminates timed-out or cancelled process groups. CLI setup failures include a fix hint. Chat text arrives when the CLI emits text events; some CLI versions only emit a completed message.
- **Background review-tip checks** — Review tips are checked automatically after generation; see [Review tips](#review-tips). The viewer opens while these checks run and updates as evidence arrives.
- **Consistent publication** — Walkthroughs and verdicts use locked, atomic writes. Tip updates are bound to a generation and reviewed revision, so a late worker cannot overwrite a newer walkthrough. Duplicate workers for the same generation are suppressed. Polling retries transient network/JSON failures; a new generation prompts a reload rather than merging results into the old review.
- **Hot-loaded walkthroughs** — The dev server reads `public/walkthroughs/*.json` from disk on every request, so newly generated walkthroughs appear without restarting `pnpm dev`.

### Review tips

Every review tip is handed to Codex for a full-code investigation, including tips from Claude-generated walkthroughs. Checks use a disposable worktree at the reviewed commit. Codex can inspect the full repository, install required test dependencies and run focused local tests. Up to three tips are checked concurrently. Each has a ten-minute total deadline and at most two Codex turns; a second turn can follow an inconclusive result that did not perform runnable checks. Results include file references and test commands with passed, failed or not-run outcomes and explanations. A static check can complete without a runtime test when its evidence settles the concern and the result explains why a test was unnecessary.

Results distinguish **verified** (the concern is addressed) from **concern** (a concrete issue remains). A check that cannot complete is marked **blocked** and remains unresolved with its reason, without an endless spinner. Blocked checks are retried when you invoke `review` again, including on a walkthrough cache hit. Finishing a check does not mean its concern has been fixed. The checker reports evidence and does not apply fixes to the target PR.

GitHub and `--local` reviews identify exact commits. For `--diff`, the checker creates a worktree at the invoking repository's committed HEAD and applies the stored patch if it applies cleanly, or accepts it as already present if a reverse check succeeds. This is best-effort reconstruction: the original patch base remains unknown and the evidence records that weaker provenance. If neither check succeeds, investigation is blocked. Repository snapshots, investigation worktrees and logs stay under this tool's local cache/output directories.

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
# Compare committed HEAD against main (uncommitted changes are excluded)
./bin/review --local

# Compare against a specific base branch
./bin/review --local develop
```

### From a patch file

```bash
./bin/review --diff path/to/changes.patch
```

Relative patch paths resolve from the directory where you invoke `review`. Patch cache identity includes the absolute path and content.

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

Choose the provider for walkthrough generation, patching, syntax repair and section chat:

- **Claude** — the Anthropic API, billed to your API key.
- **Codex** — the Codex CLI on the account used by `codex login`, with explicit model and effort settings.

Automatic review-tip investigations always use Codex with the full code, regardless of this choice.

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
| `REVIEW_CODEX_MODEL` | Model override for Codex tasks | `gpt-6.1-sol` |
| `REVIEW_CODEX_EFFORT` | Effort override for Codex tasks | task default below |
| `REVIEW_CLAUDE_MODEL` | Model override for Claude tasks, including repair | task default below |
| `REVIEW_CLAUDE_EFFORT` | Effort override for Claude tasks that support it | task default below |
| `REVIEW_MODEL` | Legacy Claude model override, excluding repair | `claude-opus-5-5` |
| `REVIEW_<PROVIDER>_<TASK>_MODEL` | Override one task's model, e.g. `REVIEW_CODEX_CHAT_MODEL` | provider/task default |
| `REVIEW_<PROVIDER>_<TASK>_EFFORT` | Override one task's effort, e.g. `REVIEW_CODEX_INVESTIGATION_EFFORT` | task default |
| `REVIEW_TIP_TIMEOUT_MS` | Total deadline per full-code tip check, from 1,000 to 1,800,000 ms | `600000` (10 minutes) |
| `REVIEW_PORT` | Dev server port | `5200` |

`PROVIDER` is `CODEX` or `CLAUDE`. Active tasks are `GENERATION`, `PATCH`, `INVESTIGATION`, `CHAT` and `REPAIR`; the configuration helper also accepts legacy `VERIFICATION`, but automatic tips use `INVESTIGATION`. A task override beats its provider-wide override. For Claude, `REVIEW_CLAUDE_MODEL` then beats legacy `REVIEW_MODEL`; legacy `REVIEW_MODEL` does not select the repair model.

| Task | Codex default | Claude default |
|------|---------------|----------------|
| Generation, patch | `gpt-6.1-sol`, medium effort | `claude-opus-5-5`, medium effort |
| Automatic tip investigation | `gpt-6.1-sol`, high effort | Uses Codex |
| Section chat | `gpt-6.1-sol`, low effort | `claude-opus-5-5`, low effort |
| Syntax repair | `gpt-6.1-sol`, medium effort | `claude-haiku-4-5-20251001`, no effort parameter |

Claude Opus uses its adaptive thinking behavior with the requested effort. Codex effort values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` or `ultra`; `gpt-6.1-sol` requires `low` or higher. Claude effort values are `low`, `medium`, `high`, `xhigh` or `max`. A model override must support the selected effort and structured output; syntax validation of the setting does not establish model availability in your account.

```bash
# Keep generation balanced and give full-code checks more reasoning
REVIEW_CODEX_GENERATION_EFFORT=medium REVIEW_CODEX_INVESTIGATION_EFFORT=high \
  ./bin/review https://github.com/owner/repo/pull/123 --codex

# Override only Claude's walkthrough model
REVIEW_CLAUDE_GENERATION_MODEL=claude-sonnet-5-5 \
  ./bin/review https://github.com/owner/repo/pull/123 --claude
```

These defaults allocate less reasoning to section chat and more to repository investigation. They have not been established as the fastest or highest-quality choice by a comparative live-model benchmark.

For Claude, copy `.env.example` to `.env` and add your key, or set it as an environment variable. Only the key is read from `.env`; other settings come from the shell environment.

### Codex execution

The runner sets an explicit model/effort, uses `--ephemeral`, ignores user config with `--ignore-user-config`, disables hooks/plugins/apps and skips host skill discovery. Review data and source code are treated as untrusted context. Project instruction loading is disabled for review tasks. Generation, patching, chat and repair disable shell tools; repository investigations use a workspace-write sandbox so Codex can install dependencies and run tests in the disposable worktree, with network access for dependency setup. The investigation instructions require evidence gathering and forbid source fixes or remote writes. Authentication still comes from your existing Codex login. Managed or administrator configuration may still apply; these flags are not a guarantee of isolation from all host policy.

Use a current CLI supporting `--ignore-user-config`, `--output-schema`, and the `hooks`, `plugins`, `apps`, `skip_host_skill_discovery`, `shell_tool` and `shell_snapshot` feature flags. An unsupported flag fails with an upgrade hint instead of silently falling back to inherited configuration.

### Calls and local data

A fresh generation normally makes a repository research call and a walkthrough call, followed by background Codex checks for its tips; incremental updates, syntax repair and retries may add calls. A matching cache avoids fresh walkthrough generation but may resume pending or blocked tip checks. Opening an existing viewer alone makes no AI calls; section chat invokes its recorded provider per message. Walkthroughs (`public/walkthroughs/`), repository/worktree caches (`.cache/`) and diagnostic logs (`logs/`) stay on your machine. GitHub comments and reviews are posted only when you submit them in the viewer.

## Project structure

```
bin/review              CLI entry point (bash)
src/
  generate.js           Walkthrough generator — fetches PR data, calls the selected AI
  ai-provider.js        Codex CLI runner shared by generation, tips and chat
  models.js             Explicit model/effort defaults and per-task overrides
  walkthrough-schema.js JSON schemas, semantic validation and derived coverage
  cache-policy.js       Input and configuration cache identity
  local-input.js        Committed local diffs and invoking-directory patch paths
  provider-config.js    Provider choice: flags, env, saved default, first-run prompt
  resolve-branch.js     Resolves a bare branch name to its PR
  resolve-info-tips.js  Background Codex review-tip checks
  repo-snapshot.js      Exact-revision repository snapshots and private worktrees
  review-storage.js     Locked atomic writes and generation-bound tip updates
  chat-context.js       Stored section narrative and actual code context
  server-chat.js        Provider-bound chat and response streaming
  server-http.js        Validated local endpoints and asynchronous gh commands
  walkthrough-poll.js   Resilient polling bound to one generation
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

## Understanding difficult changes

Generation now starts with a read-only Codex research pass over the exact reviewed
repository and the diff's merge-base revision. It traces unchanged callers,
storage and mutation paths, types and tests before the selected generation
provider writes the walkthrough. Difficult sections explain the failure mechanism,
algorithm passes and intermediate state, invariants, a worked example, alternatives
and limitations. Mechanical propagation remains brief. Research is saved with the
walkthrough and reused on an exact cache hit. A changed revision performs fresh
research, including before incremental patch generation. Patch updates may revise
sections affected indirectly through changed dependencies.

Invalid generated file or hunk references get one evidence-grounded repair attempt.
The repaired result must pass the same validation; a failed repair preserves the
previous review.

If repository research cannot complete, generation can still use the diff. The
viewer explicitly displays the research failure; it does not claim that generation
inspected the whole repository. Use `--force` to retry research on a cached review.

**Generate PR deep dive** appears in the header. **Generate detailed description**
appears on sections, dashboard cards and individual files, including Remaining
Changes. Each starts a dedicated read-only Codex agent with access to the reviewed
head and base worktrees. The task can follow dependencies outside its selected
files, but cannot edit the reviewed source or run tests. Test explanations describe
inspection evidence, not freshly executed test results. Automatic review-tip
investigations retain their separate test-capable workspaces.

Descriptions open in a reading panel and are saved locally. Closing the panel
keeps generation running; reopening it or reloading the viewer finds the same job
or saved result. Cancel and retry controls handle interrupted or failed jobs. Up to
two descriptions run per viewer server. Follow-up questions inspect the same
repository revisions and include the saved explanation as context. Follow-up
conversation is transient; it does not overwrite the saved description.

Source buttons open numbered code at the cited head or base revision, including
unchanged files and deleted base files. Paths and line numbers are validated before
a description is saved. Static HTML exports include saved descriptions and their
reference lists; generation and follow-up controls are available only in the local
viewer. Exports do not embed the repository source viewer.

Research and descriptions use Codex regardless of the walkthrough's selected
provider, like automatic full-code checks. Configure them separately with
`REVIEW_CODEX_RESEARCH_MODEL` / `REVIEW_CODEX_RESEARCH_EFFORT` and
`REVIEW_CODEX_EXPLANATION_MODEL` / `REVIEW_CODEX_EXPLANATION_EFFORT`. Both default
to high reasoning effort. Description caches include the generation identity,
head/base revisions, scope, prompt version and explanation model settings.
Background results from an older walkthrough never attach to its replacement.

Descriptions live under `.cache/explanations/`. Repository snapshots live under
`.cache/repos/`. For patch files, reconstruction uses the invoking repository's
committed HEAD with the supplied patch and discloses that the original base is
unknown. A patch that cannot be reconstructed blocks the deep dive.
