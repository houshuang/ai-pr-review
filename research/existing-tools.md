# Existing Tools Analysis

Research conducted 2026-03-10. Evaluated 25+ tools across the spectrum.

## Key Finding

**No existing tool fully combines all requirements.** The landscape splits into two camps:
1. AI tools that generate narrative summaries as PR comments (not embedded in the diff)
2. Traditional review tools that show the full diff with review tracking (no AI narrative)

## Tier 1: Closest to the Vision

### CodeSee Review Maps (with Tours)
- **Tours**: PR authors create step-by-step guided walkthroughs pinning code snippets in a reading order
- Shows actual code diff — double-click a file to open diff, select lines and add tour commentary
- Auto-generates visual dependency map of changed files
- **Gaps**: Tours are MANUAL (not AI-generated). No interdiff. No expand context.

### Reviewable
- Best-in-class **review tracking**: tracks reviewed state per file per revision per reviewer
- **Interdiff**: diff any two revisions, special support for rebases
- **Expand context**: click syntactic unit signatures to reveal full declarations
- Side-by-side and unified, auto-switches based on browser width
- **Gap**: No AI narrative, no change grouping, no diagrams

### GitClear
- Recognizes 6 types of change operations: Added, Deleted, Updated, Moved, Copy/Pasted, Find/Replaced
- ~25% of changes traditional tools label "added/deleted" are actually "moved" — de-emphasizes these
- AI summaries per file. **29% less review time** vs GitHub in studies.
- **Gap**: No cross-file narrative. No diagrams.

## Tier 2: AI Narrative (Separate from Diff)

### CodeRabbit
- Walkthrough comment on every PR: table of changed files + per-file summaries + overall prose
- Optional sequence diagrams and architecture diagrams
- Code graph analysis traces dependencies across files
- **Critical gap**: Walkthrough is a SEPARATE PR COMMENT. Does not restructure the actual diff.

### Qodo PR-Agent (Open Source)
- `/describe` generates title, type, summary, and walkthrough of changes
- Open source, self-hostable
- **Gap**: Same as CodeRabbit — walkthrough is a PR description/comment

### GitHub Copilot PR Summaries
- Prose overview + bulleted file-by-file breakdown
- **Gap**: Purely descriptive text in the PR body. Does not restructure the diff.

## Tier 3: Advanced Diff Viewers (No AI)

### SemanticDiff
- Language-aware structural diff, hides irrelevant changes (whitespace, reformatting)
- Moved code detection, refactoring detection
- Minimap, expand/collapse, mark as reviewed

### Linear Diffs
- Structural diffing reducing changed lines shown. Private beta.

### Review Board
- Interdiff, expand context, moved line detection. Open source, mature but aging.

## Tier 4: Conceptual

### Narrative Version Control
- "Before code, there is always a conversation." Replaces commit lists with narrative threads.
- Progressive disclosure: executives → managers → engineers
- Captures development process, not reviewer-facing diffs

### TigerBeetle git-review (Shelved)
- Review comments as commits on top of PR branch — inline in actual code
- "Review should be local-first with full editor capabilities"
- Shelved due to git conflict complexity

## Gap Matrix

| Requirement | Best Current Tool |
|---|---|
| AI narrative walkthrough | CodeRabbit, PR-Agent (separate comment) |
| Shows ALL code in diff | Reviewable, GitHub, SemanticDiff |
| Groups related changes | CodeSee Tours (manual), SemanticDiff (structural) |
| Review tracking | Reviewable (best), diffty, SemanticDiff |
| PR version interdiff | Reviewable (best), Review Board |
| Expand context | Reviewable, Review Board, SemanticDiff |
| Unified/side-by-side | Reviewable, Review Board, SemanticDiff |
| Clickable navigation | Sourcegraph (go-to-definition in PRs) |

## Building Blocks

| Layer | Best option | Notes |
|---|---|---|
| Diff rendering | diff2html, @git-diff-view/react | diff2html: mature, split/unified. @git-diff-view/react: widget system for annotations |
| Diff parsing | parse-git-diff, jsdiff | Parse unified diffs into structured ASTs |
| Syntax highlighting | Shiki (via @git-diff-view/shiki) | VS Code-quality, TextMate grammars |
| Code navigation | web-tree-sitter | AST parsing in browser via WASM |
| Diagrams | Mermaid.js | AI generates text, Mermaid renders |
| GitHub data | Octokit REST API, gh CLI | PR diffs, file contents, commits |

## Sources
- CodeRabbit: coderabbit.ai
- Reviewable: reviewable.io, docs.reviewable.io
- CodeSee: codesee.io/code-reviews
- GitClear: gitclear.com
- SemanticDiff: semanticdiff.com
- Narrative Version Control: thoughts-and-experiments.github.io/Narrative-Version-Control/
- TigerBeetle: tigerbeetle.com/blog/2025-08-04-code-review-can-be-better/
