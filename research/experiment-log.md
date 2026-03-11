# Experiment Log

## 2026-03-10: Initial Prototype

### Problem
No tool exists that combines AI-generated narrative walkthroughs with actual code review. The landscape splits into: (1) AI tools that generate summaries as separate PR comments, and (2) traditional review tools that show diffs without narrative. Reviewers at quality-focused teams still need to read every line but lack tools that help them understand *where to start* and *how the pieces connect*.

### Changes
1. Built CLI generator (`src/generate.js`) that fetches PR via `gh` CLI, sends diff to Claude Sonnet, gets structured walkthrough JSON
2. Built Vite SPA viewer (`src/app.js`, `src/styles.css`) with pr-walkthrough aesthetic
3. Added interactive features: split/unified diff, section collapse, review checkboxes, progress bar, minimap, Mermaid diagrams, keyboard shortcuts
4. Added GitHub integration: fetch comments/reviews, display inline, comment composer, approve/request changes

### Key Design Decisions
- **Structured JSON, not monolithic HTML**: Claude returns JSON with sections/hunks/annotations. We render interactively. This enables collapse/expand, tracking, mode switching — things static HTML can't do.
- **Hunk grouping by file**: The AI might reference the same file 3 times in one section. We deduplicate: show all annotations stacked, then the diff once.
- **gh CLI as auth layer**: Instead of managing GitHub tokens in the browser, we proxy through `gh api` via Vite middleware. The user's existing `gh auth` handles auth.
- **diff2html for rendering**: Mature library, handles split/unified, syntax highlighting, matches GitHub's visual style.

### Known Gaps (from this session)
1. ~~NOT ALL CODE IS SHOWN~~ — **FIXED**: Added Remaining Changes section + coverage bar
2. ~~Comments on files not in walkthrough sections are invisible~~ — **FIXED**: Visible in remaining section
3. ~~Full file diffs shown per hunk~~ — **FIXED**: `filterFileToRanges()` filters diff2html blocks to referenced lines, toggle for full view
4. Full re-render on every interaction (no incremental DOM updates)
5. `md()` function double-escapes HTML entities in code blocks
6. No visual indicator of "current section" for keyboard navigation
7. ~~Mermaid fence markers in AI output~~ — **FIXED**: Stripped before rendering

### Files Created
- `index.html` — Entry point
- `src/app.js` — Main application (~900 lines)
- `src/styles.css` — All styles (~1000 lines)
- `src/generate.js` — CLI generator (~300 lines)
- `vite.config.js` — Vite config with gh API proxy middleware
- `package.json` — Dependencies: diff2html, @anthropic-ai/sdk, vite

### Verification
- Tested with React PR #35985 (3 files, small), shadcn/ui PR #9903 (6 files, medium), React PR #35945 (21 files, large with comments)
- Visual testing via agent-browser: header, TOC, diffs (split+unified), callouts, diagrams, review checkboxes, collapse/expand, comments display, review summary all confirmed working
- GitHub comment posting and review submission wired up but not tested end-to-end (requires write access to a PR)

### Next Priority
~~Complete code coverage~~ — **DONE** (2026-03-10, second session). Added Remaining Changes section with:
- Coverage bar showing "N/M files narrated, K in Remaining Changes below"
- Files grouped by directory, each with checkbox, stats, collapsed diff
- File-level review tracking in localStorage
- Comment composers on remaining files
- Mermaid fence stripping fix (AI sometimes includes ```mermaid markers)

~~**Current priority**: Hunk-level diff filtering~~ — **DONE** (2026-03-10). `filterFileToRanges()` filters diff2html blocks to referenced line ranges with 5-line context margin, toggle for full view.

## 2026-03-10: Expand Context, Jump-to-Def, View Layouts, Line Selection

### Changes
1. Added expand context (fetch full file from GitHub, show N lines above/below diff blocks)
2. Added Ctrl/Cmd+click jump to definition (regex-based search across all diffs)
3. Added 6 view layouts: Editorial, Sidebar, Focus, Split, Developer, Dashboard
4. Added line selection for commenting (click line numbers)
5. Added dark mode toggle
6. Added file age/churn badges and commit timeline in header
7. Added comment side select (LEFT/RIGHT for split diffs)

## 2026-03-11: Quick Wins (10 research-backed improvements)

### Background
Deep HCI/CHI research synthesis (~150 papers) identified 10 low-effort, high-impact improvements grounded in specific research findings. See `research/hci-research.md` and `research/design-ideas.md` Section J.

### Changes
1. **"N min read" in TOC** — `getEstimatedReadTime()` counts prose words (~200/min) + code lines (~30/min). Grounded in bounded progress framing research.
2. **Auto-collapse supporting/context hunks** — `applyAutoCollapse()` runs at data load, respects persisted state. Based on TASSAL (Fowkes et al., TSE 2016) showing 28% error reduction with importance-based folding.
3. **`n` keyboard shortcut** — Jumps to first unreviewed section. Addresses satisfaction-of-search dropout (Begel & Vrzakova 2018).
4. **File count in section headers** — "Section 01 · 3 files" for quick scanning.
5. **Review complete banner** — Green confirmation strip with Approve/Request Changes when progress reaches 100%. Completion incentive from goal-gradient research.
6. **Remaining files sorted by size** — Largest changes first, fighting file-order bias (Fregnan et al., ESEC/FSE 2022 — files shown first get 64% more defect detection).
7. **Comment count per section in TOC** — Cross-references `data.comments` with section hunk files.
8. **Reviewer names in header** — Shows unique reviewer names from `data.reviews`. Social accountability effect.
9. **`?` keyboard shortcut** — DOM-appended modal listing all shortcuts. Closes on backdrop click or re-pressing ?.
10. **Collapsed state persistence** — `collapsedSections` and `collapsedHunks` saved to separate localStorage key alongside review state.

### Key Design Decisions
- Auto-collapse runs ONCE at data load, then persisted state takes over. This means if a user manually expands a supporting hunk, it stays expanded across page reloads.
- Read time estimates are rough (words/200 + codeLines/30) but provide useful relative sizing between sections. A section showing "2 min" vs "129 min" immediately signals where the bulk of review effort lies.
- Shortcuts modal is created/destroyed from DOM (not hidden/shown) to avoid cluttering the page when not needed.

### Verification
All 10 features verified via agent-browser against the React PR #35945 demo data:
- TOC shows read times (7 min, 2 min, 129 min, 33 min, 65 min)
- 3 supporting hunks auto-collapsed on load
- Remaining files sorted: +38, +29, +27, +23, +1
- Reviewer names: "eps1lon, unstubbable"
- Section headers: "Section 01 · 4 files", "Section 03 · 1 file"
- Review complete banner appears with Approve/Request Changes buttons
- Shortcuts modal renders correctly with all 5 shortcuts
- Collapsed state persisted in localStorage

## 2026-03-11: Interaction Testing, Prompt Rewrite, Git History Enrichment

### Changes
1. **Thorough interaction testing** — 17 interactions tested via agent-browser across all 6 views
2. **Bug fix: comments toggle** — Comment composers weren't hidden when comments toggled off (both in walkthrough sections and remaining files)
3. **System prompt rewrite** — Difftastic-inspired structural change philosophy:
   - "Think structurally, not textually" — describe transformations, not line changes
   - "What hasn't changed" anchoring — orient reader in stable context first
   - Active verb section titles ("Extract renderer capabilities" not "Module Extraction")
   - Delta-focused annotations ("Replaces monolithic export with re-exports" not "Exports modules")
   - Progressive section flow with explicit connections between sections
   - New "question" callout type for reviewer verification items
4. **User prompt improvement** — Now includes existing review comments and review state
5. **Git history enrichment** (added by hooks) — `fetchGitHistory()` fetches commit details, file churn (files touched multiple times), and code age (last modified date on base branch). Formatted into user prompt for narrative context.

### Difftastic Research Insights
Researched difftastic (https://difftastic.wilfred.me.uk/) for ideas:
- Core concept: "the goal of diffing is to work out what *hasn't* changed" — structural/AST-based, not line-based
- Token-level highlighting (specific changed tokens, not whole lines)
- Slider correction: when multiple equivalent diffs exist, prefer the one that looks most natural
- Wrapper detection: code wrapped in new control flow shows inner code as unchanged
- Applied to our prompt: the AI should explain structural changes (moved code, wrapped code, split/merged) rather than listing "lines added"

### Prompt Quality Comparison

| Aspect | Before | After |
|--------|--------|-------|
| Title | "React Noop Renderer Fiber Configuration Refactor" | "Extract noop renderer configuration into modular architecture" |
| File coverage | 7/12 narrated | 12/12 narrated |
| Annotations | Describe result ("Exports configuration pieces") | Describe delta ("Replaces monolithic implementation with re-exports") |
| Section flow | Independent sections | "Building on the extracted modules from the previous sections..." |
| Diagrams | Generic boxes per file | Structural decomposition (Monolithic Config → extracted modules with counts) |

### Verification
All 6 views tested with both old and new walkthrough data:
- Editorial: toolbar buttons, split/unified toggle, expand/collapse, comments toggle, review checkboxes
- Sidebar: file tree navigation, section links scroll to content
- Focus: step dots, prev/next buttons, dashboard card → focus transition
- Split: independent pane scroll, dark mode
- Developer: forced dark mode, monospace styling
- Dashboard: card grid, click to focus mode
- Dark mode: persists across view switches and page reloads
- Keyboard: j/k navigation, n next unreviewed, r review, e collapse
