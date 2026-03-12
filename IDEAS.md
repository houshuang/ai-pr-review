# Review Tool — Ideas

> This file tracks ALL ideas for the project. Never delete ideas. Mark as [DEFERRED], [REJECTED], or [DONE] with reasoning. Every agent should add new ideas discovered during work.

## Core Philosophy

The fundamental insight: existing tools treat "AI understanding" and "human review" as separate activities. AI tools generate summaries *about* the diff; review tools show the diff *without* understanding. This tool bridges them — using AI to *structure* the review experience while keeping the human responsible for reading every line.

The closest analogy is how a good textbook doesn't just dump information — it sequences concepts, groups related ideas, provides diagrams at the right moments, and builds understanding progressively. Nobody has applied that to code review yet.

---

## Complete Code Coverage (CRITICAL)

The reviewer MUST see every line of changed code. This is non-negotiable — this is a tool for teams that take quality seriously and take responsibility for their code reviews.

- **Every file in the diff must appear somewhere in the walkthrough** — either in a narrative section or in a "remaining changes" pane
- **Bulk/mechanical changes should be grouped smartly** — e.g. "Updated function signature in 10 call sites" can be a collapsed group, but the code must be there
- **Importance tiers**: critical (must read carefully), important (should read), supporting (skim), bulk (verify pattern). The AI should classify.
- **Tracking which code the reviewer has actually seen** — not just "marked section as reviewed" but ideally tracking scroll/visibility
- [DONE] Basic hunk grouping by file within sections
- [DONE] Remaining Changes section for files not in walkthrough narrative
- [DONE] Coverage bar showing narrated vs remaining file counts
- [DONE] File-level review checkboxes in remaining section
- [DONE] Files collapsed by default in remaining section
- [DONE] The AI prompt explicitly requires ALL files in file_map

## Narrative Structure

- [DONE] AI generates structured JSON walkthrough with sections, annotations, diagrams
- [DONE] Sections group related changes across files
- [DONE] Progressive ordering: types → core logic → wiring → UI
- Narrative should adapt to PR type (new feature vs refactor vs bug fix vs dependency update)
- For large PRs: executive summary → detailed sections → appendix of mechanical changes
- Allow the AI to suggest a "reading path" — critical path vs completionist path

## Diff Rendering

- [DONE] Side-by-side and unified diff toggle
- [DONE] diff2html rendering with syntax highlighting
- [DONE] Grouped by file within sections (no duplicate file diffs)
- [DONE] Collapsible file diffs
- [DONE] Hunk-level diff filtering — show only relevant line ranges per hunk with "show all" toggle
- [DONE] Expand context up/down (fetch full file from GitHub API, merge extra lines)
- Line-level annotations from the AI (not just file-level)
- [DONE] Click on function/type names to jump to definition (regex-based search across diff, Ctrl/Cmd+click)
- Minimap within large diffs showing where the important changes are

## Review Tracking

- [DONE] Per-section review checkboxes with localStorage persistence
- [DONE] Progress bar and minimap
- Per-hunk review tracking (more granular than per-section)
- Track which code the reviewer has actually scrolled past / had in viewport
- "What changed since my last review" — store reviewed commit SHA, show interdiff
- Export review state as JSON (for sharing/backup)

## GitHub Integration

- [DONE] Fetch existing review comments and display inline
- [DONE] Reviews summary (approved/changes requested/commented)
- [DONE] Comment composer per file with line range selection (click + shift-click on diff lines)
- [DONE] Multi-line range comments synced to GitHub (start_line/line API)
- [DONE] Approve / Request Changes buttons with modal
- [DONE] Refresh comments from GitHub
- [DONE] Vite middleware proxying gh CLI for API calls
- Reply to existing comment threads
- Edit/delete own comments
- Show GitHub CI check status
- Link back to specific lines in GitHub's diff viewer
- Resolve/unresolve comment threads
- Show PR description and linked issues
- [DONE] Comments on files NOT in the walkthrough sections visible in Remaining Changes section

## UI / UX

- [DONE] pr-walkthrough aesthetic (warm paper, editorial typography)
- [DONE] Keyboard shortcuts (j/k navigate, r review, e expand/collapse, n next unreviewed, ? help)
- [DONE] Mermaid diagrams for architecture/flow
- [DONE] Importance badges (critical/important/supporting/context)
- [DONE] TOC with review state, estimated read time per section, comment counts
- [DONE] Auto-collapse supporting/context hunks (progressive disclosure)
- [DONE] File count shown in section headers ("Section 01 · 3 files")
- [DONE] Review complete banner with Approve/Request Changes when all sections checked
- [DONE] Remaining files sorted by size (lines changed) descending
- [DONE] Reviewer names from PR metadata shown in header
- [DONE] Collapsed/expanded state persisted in localStorage
- [DONE] Multiple view layouts: Editorial, Sidebar, Focus, Split, Developer, Dashboard
- [DONE] Dark mode
- Pages/panes for large PRs — don't show everything at once
  - [DONE] Focus mode showing one section at a time
  - [DONE] Sidebar layout with file tree + section nav
  - [DONE] Split layout with narrative left, code right
  - [DONE] Dashboard grid overview
- [DONE] Preact + signals rewrite — reactive components, no more full DOM re-render
- [DONE] Mark reviewed at bottom of section, auto-collapses and scrolls to header
- Sticky toolbar that follows scroll
- Print/export to PDF for offline review
- Mobile-responsive for reviewing on iPad

## Generation / AI

- [DONE] CLI generator using Claude API (Sonnet)
- [DONE] Fetches PR via gh CLI
- [DONE] Supports GitHub PRs, local diffs, patch files
- In-browser generation (call API directly from client, streaming)
- Streaming walkthrough generation — show sections as they're generated
- Allow regenerating individual sections
- "Ask about this code" — inline AI Q&A on specific hunks
- Custom system prompts per team/project (code style, architecture conventions)
- Cost optimization: use Haiku for mechanical change grouping, Sonnet for narrative
- [DONE] Git history metadata injected into AI prompt (commit sequence, file ages, churn)

## Git History & Code Evolution

- [DONE] Commit timeline in viewer header (collapsible, shows all PR commits)
- [DONE] File age badges on hunk headers (last modified date from base branch)
- [DONE] File churn badges showing iteration count (files touched multiple times in PR)
- [DONE] Generator fetches commit history, file ages, and churn data via GitHub API
- [DONE] AI narrative enriched with git history context (code age, iteration patterns)
- Per-line commit attribution (which commit introduced each change)
- Git blame integration showing age of individual lines being modified
- "Addressed in commit N" labels on review comments when code changed after feedback
- Temporal coupling detection (files that always change together)
- Hotspot visualization showing high-churn areas

## Multi-Version / Iteration Support

- Store previous walkthrough versions
- When PR is force-pushed: regenerate walkthrough, highlight what changed since last review
- Show "this section is unchanged since your last review" badges
- Diff-of-diffs: what changed between force-pushes

## Collaboration

- Share walkthrough links with teammates
- Real-time collaborative review (multiple reviewers see each other's progress)
- "I agree with this comment" reactions
- Review assignment / distribution for large PRs

## Developer Experience

- `npx review-tool https://github.com/...` — zero-install usage
- VS Code extension that opens the walkthrough in a webview
- GitHub Action that auto-generates walkthrough on PR creation
- Slack bot integration

---

## Research Needed

See `research/` directory for deep dives.

- **research/existing-tools.md** — Comprehensive analysis of existing code review tools
- **research/diff-libraries.md** — Evaluation of diff rendering libraries
- **research/ai-prompt-engineering.md** — Iterating on the walkthrough generation prompt
