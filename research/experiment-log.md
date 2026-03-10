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
1. **NOT ALL CODE IS SHOWN** — Critical gap. The AI selects ~60-70% of changed files for the narrative. Remaining files are invisible. A reviewer cannot complete their review in this tool alone.
2. Comments on files not featured in walkthrough sections are invisible (orphaned comments)
3. Full file diffs shown per hunk (no line-range filtering) — makes diffs very tall
4. Full re-render on every interaction (no incremental DOM updates)
5. `md()` function double-escapes HTML entities in code blocks
6. No visual indicator of "current section" for keyboard navigation
7. Mermaid `renderMermaid()` called on every render cycle (wasteful)

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
**Complete code coverage** — Every file in the diff MUST appear somewhere in the walkthrough. This is the single most important gap. Options:
1. Improve AI prompt to require ALL files in sections
2. Add an "Other Changes" section that automatically includes files the AI didn't cover
3. Add a "Files not yet reviewed" sidebar/pane
