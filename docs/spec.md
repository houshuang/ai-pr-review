# Review Tool — Specification

## What This Is

An AI-narrated interactive code review tool. Takes a PR diff, uses Claude or Codex to generate a structured walkthrough that guides the reviewer through the changes in logical narrative order, then renders it as an interactive web app where the reviewer can read every line of code, track their progress, and interact with GitHub (comments, approvals).

## Core Principle

**The reviewer reads ALL the code.** This is not an AI-that-reviews-for-you tool. This is a tool for teams that take quality seriously and take responsibility for their code reviews. The AI provides *structure and narrative*, the human provides *judgment and approval*.

## User Flow

```
1. Generate:  node src/generate.js https://github.com/owner/repo/pull/123
2. View:      pnpm dev → opens in browser
3. Read:      Follow the narrative, section by section
4. Review:    Check off sections as reviewed, leave comments
5. Submit:    Approve or request changes
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│  CLI Generator (src/generate.js)                │
│  - Fetches PR data + git history via gh CLI     │
│  - Sends diff + history to Claude or Codex     │
│  - Outputs structured JSON                      │
└──────────────────────┬──────────────────────────┘
                       │ walkthrough-data.json
┌──────────────────────▼──────────────────────────┐
│  Preact SPA (src/app.jsx)                       │
│  - Preact + @preact/signals for reactive state  │
│  - 6 switchable view layouts + dark mode        │
│  - diff2html for code rendering (filtered hunks)│
│  - Mermaid for diagrams                          │
│  - localStorage for review + view state          │
└──────────────────────┬──────────────────────────┘
                       │ /api/gh proxy
┌──────────────────────▼──────────────────────────┐
│  Vite Middleware (vite.config.js)                │
│  - @preact/preset-vite for JSX                  │
│  - Proxies GitHub API calls through gh CLI      │
│  - Enables comment posting, review submission   │
│  - Serves walkthrough JSONs from disk per req   │
│    (no restart needed for new walkthroughs)     │
└─────────────────────────────────────────────────┘
```

### Frontend Module Structure

```
src/
  app.jsx                  — Entry point: renders <App /> into #app
  state.js                 — Preact signals for all app state + derived state
  utils.js                 — esc(), md(), timeAgo(), groupFilesByDirectory(), getFileStats()
  diff.js                  — parseDiff(), renderFileDiff(), filterFileToRanges(), diff2html wrappers
  api.js                   — GitHub API: comments, reviews, file content, expand context
  keyboard.js              — getActionItems() for keyboard shortcuts + action panel
  mermaid.js               — Mermaid loading + useMermaid() hook + click-to-zoom overlay
  mermaid-sanitize.js      — Pre-render sanitization for common LLM mermaid mistakes
  generate.js              — CLI walkthrough generator (Node-side)
  resolve-info-tips.js     — CLI background resolver, invoked by generate.js after
                             writing the walkthrough when review_tips have
                             pending or blocked entries. Every tip is checked by
                             Codex against full code in a disposable worktree, with
                             focused local tests and a ten-minute total per-tip deadline.
  styles.css               — All styles (unchanged from pre-Preact)
  components/
    App.jsx                — Root: auto-loads data, keyboard handler, layout router
    Landing.jsx            — Landing page (PR URL input, file load, demo)
    Section.jsx            — Walkthrough section with narrative, callouts, diffs
    HunkGroup.jsx          — File diff block: header, DiffView, comments, composer
    DiffView.jsx           — diff2html output via dangerouslySetInnerHTML
    RemainingChanges.jsx   — Uncovered files grouped by directory
    Header.jsx, Footer.jsx, TOC.jsx, Overview.jsx, Minimap.jsx, etc.
    BottomBar.jsx          — Status bar with progress, diff toggle, actions
    ActionPanel.jsx        — Command palette (. key)
    ReviewModal.jsx        — Approve/request changes modal
    layouts/
      EditorialLayout.jsx  — Default linear scroll layout
      SidebarLayout.jsx    — Fixed sidebar + scrollable main
      FocusLayout.jsx      — One section at a time with stepper
      SplitLayout.jsx      — Narrative left, code right
      DashboardLayout.jsx  — Card grid overview
```

## Walkthrough JSON Schema

The AI generates this structure. The viewer renders it interactively.

```typescript
interface Walkthrough {
  title: string;
  subtitle: string;
  overview: string;              // markdown
  architecture_diagram: string;  // mermaid
  sections: Section[];
  file_map: FileMapEntry[];
  review_tips: ReviewTip[] | string[];  // generated concerns, then persisted investigation results
}

interface ReviewTip {
  tip: string;                   // the original concern text
  status: 'verified' | 'concern' | 'info';
  finding: string;               // evidence with file:line references
  pending?: boolean;            // true while queued/running; false for complete/blocked
  resolved?: boolean;           // complete investigation, not necessarily a fixed concern
  investigationState?: 'running' | 'complete' | 'blocked';
  evidence?: { files: string[]; tests: Array<{ command: string; outcome: 'passed' | 'failed' | 'not-run'; detail: string }> };
}

interface Section {
  id: string;                    // kebab-case
  title: string;
  narrative: string;             // markdown
  diagram: string | null;        // mermaid
  hunks: Hunk[];
  callouts: Callout[];
}

interface Hunk {
  file: string;
  startLine: number;
  endLine: number;
  annotation: string;
  importance: 'critical' | 'important' | 'supporting' | 'context' | 'bulk';
}

interface Callout {
  type: 'insight' | 'warning' | 'pattern' | 'tradeoff' | 'question';
  label: string;
  text: string;
}
```

### Output JSON (walkthrough-data.json)

The generator bundles the walkthrough with raw data and metadata:

```typescript
interface WalkthroughData {
  meta: { source, owner, repo, number, title, url, baseBranch, headBranch, baseSha, headSha,
          provenance, repositoryPath, generationId, configFingerprint, inputHash, modelTasks,
          additions, deletions, changedFiles, generatedAt, aiProvider };
  walkthrough: Walkthrough;
  diff: string;
  comments: Comment[];      // GitHub review comments
  reviews: Review[];        // GitHub review states
  gitHistory: GitHistory;   // Git history metadata
}

interface GitHistory {
  commits: Array<{
    sha: string;            // short (7 char)
    fullSha: string;
    author: string;
    date: string;
    message: string;        // first line only
  }>;
  fileAges: Record<string, {
    lastModified: string;   // ISO date
    lastAuthor: string;
    daysSince: number;
  }>;
  churn: Record<string, {
    touchCount: number;     // how many PR commits touched this file
  }>;
}
```

## Complete Code Coverage Requirement

**Every file in the diff MUST appear in the walkthrough.** The AI should:

1. **Narrative sections**: Files with interesting changes get detailed treatment with annotations
2. **Grouped mechanical changes**: When a signature change propagates to 10+ files, group them as "Updated 12 call sites for new signature" with the actual diffs collapsed but present
3. **Remaining changes section**: Auto-generated catch-all for any files the AI didn't explicitly cover

The viewer should:
- Track which files have been seen vs unseen
- Show a "files remaining" counter
- Provide a way to quickly scan/dismiss bulk changes
- Never let the reviewer submit a review without at least scrolling past every file

## Importance Classification

| Level | Meaning | UI Treatment |
|---|---|---|
| critical | Core logic, security, data integrity | Red left border, expanded by default, must review |
| important | Key behavior changes | Blue left border, expanded by default |
| supporting | Boilerplate, config, imports | Gray border, collapsed by default |
| context | Unchanged code for understanding | Light border, collapsed |
| bulk | Mechanical/repetitive changes | Grouped, single annotation for the group, collapsed |

## Design Aesthetic

Matches the pr-walkthrough skill: editorial / technical paper style.

- **Fonts**: Instrument Serif (headings), Inter (body), JetBrains Mono (code)
- **Diff colors**: GitHub-inspired — green `#c8f0ce` (additions), red `#ffebe9` (deletions), inline highlights `#a8e6b0` / `#ffd7d5`
- **Feel**: Stripe engineering blog or well-written RFC
- **Width**: 1400px max-width for wide diffs

## Keyboard Shortcuts

All shortcuts are accessible via the `.` (period) key action panel, which slides up from the bottom bar. Single-letter shortcuts work both when the panel is open and directly from the keyboard.

| Key | Action |
|---|---|
| . | Toggle action panel |
| j / k | Navigate to next/previous section |
| n | Jump to next unreviewed section |
| r | Toggle review on current section |
| e | Expand all sections |
| w | Collapse all sections |
| s / u | Switch to split / unified diff |
| d | Toggle dark mode |
| c | Toggle GitHub comments |
| h | Hide reviewed sections |
| g | Open PR on GitHub (new tab) |
| a | Approve PR |
| x | Request changes |
| f | Refresh comments from GitHub |
| 1-6 | Switch view layout |
| ? | Show shortcuts help |
## GitHub Integration

- **Read**: PR metadata, diff, review comments, reviews, commit history, file ages/churn
- **Write**: Post comments on specific lines or line ranges (`start_line`/`line` API), submit reviews (approve/request changes/comment)
- **Auth**: Proxied through local `gh` CLI (no token management needed)
- **Commenting flow**: Click a line number → auto-fills composer. Shift+click for range. Side selector (new/old code). Posts immediately to GitHub.

## Generation Prompt Philosophy

The system prompt follows a structural change philosophy inspired by difftastic:

- **Think structurally, not textually** — describe semantic transformations, not line changes
- **Anchor on what hasn't changed** — orient the reader in stable context before describing the delta
- **Active verb section titles** — "Extract renderer capabilities" not "Module Extraction"
- **Delta-focused annotations** — describe what changed, not what the code is now
- **Progressive section flow** — each section builds on the previous with explicit connections
- **Git history awareness** — commit sequence, file churn, and code age inform the narrative

## View Layouts

| Layout | Description |
|---|---|
| Editorial | Default. Full-width linear scroll with TOC, minimap, progress bar |
| Sidebar | Fixed left panel with TOC + file tree, scrollable main area |
| Focus | One section at a time with step dots and prev/next navigation |
| Split | Narrative left pane, code diffs right pane (synchronized) |
| Developer | Monospace, compact, dark mode forced |
| Dashboard | Grid of section cards for quick overview, click to drill in |

## Current State (2026-09-30)

### Working
- CLI generation from GitHub PRs, local diffs, patch files
- Git history enrichment: commit details, file churn detection, code age
- Difftastic-inspired structural prompt: delta-focused annotations, "what hasn't changed" anchoring
- **Preact + signals frontend** — reactive component architecture replacing vanilla innerHTML
- 6 view layouts: Editorial, Sidebar, Focus, Split, Developer, Dashboard
- Split/unified diff, collapse/expand, review checkboxes (top + bottom of sections)
- Mark reviewed auto-collapses section and scrolls to header
- Mermaid diagrams, callouts, importance badges
- Click-to-zoom pan/zoom overlay for architecture diagrams (works in Preact viewer and in static HTML export)
- Automatic review-tip checks: every tip runs through Codex full-code investigation, regardless of walkthrough provider. Private worktrees isolate dependency setup and local tests from the invoking checkout. A result is verified/concern with completed evidence, or blocked and unresolved with a reason. Pending/blocked checks retry on the next review invocation. Investigations use a pool of three, up to two Codex turns and a ten-minute total per-tip deadline (`REVIEW_TIP_TIMEOUT_MS`, bounded 1–1800 seconds). File references and test command/outcome/detail are persisted as evidence.
- Generation-bound publication: locked atomic JSON writes prevent truncated reads and stale verdicts overwriting newer reviews. The viewer polls every 4s while tips are pending, retries transient fetch/parse failures, and requests reload if the generation changes.
- Grounded section chat: the server reads the stored generation/section and actual diff hunks, validates request identity and streams provider output. Local endpoints use bounded requests, origin checks, supported GitHub operation allowlists and asynchronous shell-free commands.
- Walkthroughs middleware (vite.config.js `walkthroughsEndpoint`): serves `/walkthroughs/*.json` and `/walkthrough-data.json` from disk on every request, ahead of Vite's static handler. Lets newly generated walkthroughs load without restarting the dev server (Vite's static handler caches the `public/` listing at startup, otherwise serving the SPA's `index.html` for unseen JSON files)
- GitHub comment display with syntax-highlighted code blocks (highlight.js)
- Comment composer, approve/request changes modal
- Dark mode toggle
- Expand context up/down (fetch full file from GitHub API)
- Ctrl/Cmd+click jump to definition (regex-based across diff)
- Line range selection for commenting (click + shift-click, multi-line range sync to GitHub)
- Commit timeline in header (collapsible, shows PR commit sequence)
- File age badges on hunk headers (last modified date, color-coded by age)
- File churn badges showing iteration count (files revised multiple times)
- Auto-collapse supporting/context hunks (progressive disclosure)
- Estimated read time per section in TOC
- Comment count per section in TOC
- File count in section headers
- Review complete banner when all sections checked
- Remaining files sorted by size descending
- Reviewer names from PR metadata in header
- Collapsed/expanded state persisted in localStorage
- Bottom action panel (`.` key) with full keyboard shortcuts (single-letter)
- GitHub-inspired diff colors (strong green/red, word-level highlight merging)
- Word wrap in unified diff view (split view preserves horizontal scroll)
- Hunk-level diff filtering: only shows referenced line ranges, not full file diffs
- Interleaved annotations: each annotation appears above its matching diff hunk
- "Open PR on GitHub" action for quick navigation to the source PR
- Stale review banner: on view, fetches current PR head; if it differs from `meta.headSha`, displays new commits and diff totals. Generation checks both base and head after fetching the diff, retries moving revisions up to three times and fails if it cannot establish a stable snapshot.
- Input-aware cache: reuse requires matching source/input provenance, base/head revisions, title/body, provider, task model/effort configuration and prompt version. Cache hits retain generation identity/time and refresh comments/reviews; older caches regenerate once. Local reviews cover committed HEAD, excluding dirty changes; patch paths resolve from the invoking directory and cache identity includes their path/content. `--diff` investigation reconstructs a best-effort private worktree from invoking committed HEAD plus the stored patch (or confirms the patch already exists with a reverse check); original patch-base provenance remains unknown, and unsafe reconstruction blocks the check.
- Incremental re-review: a linear head advance on the same source, branch, base and configuration can use the delta against the cached head. A rewind/divergent head triggers full generation. An eligible empty delta reuses the narrative under a new generation with tip checks repeated. Small deltas (≤30KB, ≤8 affected files) use a JSON patch from the selected provider, merged by `applyWalkthroughPatch` and validated against the current full diff. Larger/unavailable deltas and invalid patches fall back to full generation.
- Structured output: both providers receive schemas; local semantic validation checks unique section identifiers and hunk endpoints against the real diff (old-side for deleted files), and derives complete file coverage. Malformed responses first use local syntax repair, then the provider's repair task (Claude defaults to Haiku 4.5). Failed responses are retained under `logs/`.
- Explicit task configuration: Codex defaults to `gpt-6.1-sol`; Claude defaults to `claude-opus-5-5`. Chat uses low effort, generation/patch use medium, and full-code investigations use high. Per-task environment overrides beat provider-wide settings. These defaults are not a comparative live-model benchmark; see README configuration for details and execution limitations.

### Remaining Gaps
1. No streaming generation / in-browser generation
2. No interdiff support (show what changed between force-pushes)

## Repository-grounded explanations

The generator performs read-only repository research before synthesis; difficult
narratives teach invariants, algorithm state, alternatives and concrete scenarios.
On-demand PR/section/file descriptions use a dedicated Codex task over pinned head
and merge-base snapshots. Results are generation-bound, cached independently from
review findings, and included in static exports. The viewer supports background
jobs, cancellation/retry, follow-ups and source excerpts beyond the diff. Research
failure is disclosed as diff-only generation. See README's “Understanding difficult
changes” for task settings, persistence and patch provenance.
