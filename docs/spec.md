# Review Tool — Specification

## What This Is

An AI-narrated interactive code review tool. Takes a PR diff, uses Claude to generate a structured walkthrough that guides the reviewer through the changes in logical narrative order, then renders it as an interactive web app where the reviewer can read every line of code, track their progress, and interact with GitHub (comments, approvals).

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
│  - Fetches PR data via gh CLI                   │
│  - Sends diff to Claude API                     │
│  - Outputs structured JSON                      │
└──────────────────────┬──────────────────────────┘
                       │ walkthrough-data.json
┌──────────────────────▼──────────────────────────┐
│  Vite SPA (src/app.js + src/styles.css)         │
│  - Renders walkthrough with editorial aesthetic  │
│  - Interactive: collapse, diff modes, review     │
│  - diff2html for code rendering                  │
│  - Mermaid for diagrams                          │
│  - localStorage for review state                 │
└──────────────────────┬──────────────────────────┘
                       │ /api/gh proxy
┌──────────────────────▼──────────────────────────┐
│  Vite Middleware (vite.config.js)                │
│  - Proxies GitHub API calls through gh CLI      │
│  - Enables comment posting, review submission   │
└─────────────────────────────────────────────────┘
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
  review_tips: string[];
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
  type: 'insight' | 'warning' | 'pattern' | 'tradeoff';
  label: string;
  text: string;
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

- **Fonts**: Instrument Serif (headings), Source Serif 4 (body), DM Mono (code)
- **Colors**: Warm paper (#f5f0e8), ink (#1a1a18), accent red (#c23616), semantic blue/green/purple/orange
- **Feel**: Stripe engineering blog or well-written RFC

## Keyboard Shortcuts

| Key | Action |
|---|---|
| j / k | Navigate to next/previous section |
| r | Toggle review on current section |
| e | Expand/collapse current section |
| n | Jump to next unreviewed section (planned) |
| ? | Show keyboard shortcuts (planned) |

## GitHub Integration

- Read: PR metadata, diff, review comments, reviews, CI status (planned)
- Write: Post comments on specific lines, submit reviews (approve/request changes/comment)
- Auth: Proxied through local `gh` CLI (no token management needed)

## Current State (2026-03-10)

### Working
- CLI generation from GitHub PRs, local diffs, patch files
- Interactive viewer with full editorial aesthetic
- Split/unified diff, collapse/expand, review checkboxes
- Mermaid diagrams, callouts, importance badges
- GitHub comment display, review summary
- Comment composer, approve/request changes modal

### Critical Gaps
1. ~~Not all code is shown~~ — **FIXED**: Remaining Changes section shows all uncovered files
2. ~~Comments on files not in walkthrough sections are invisible~~ — **FIXED**: Comments visible in remaining section
3. ~~No line-range filtering for diffs~~ — **FIXED**: Diffs filtered to referenced line ranges with "show all" toggle
4. Full DOM re-render on every interaction
5. No streaming generation / in-browser generation
