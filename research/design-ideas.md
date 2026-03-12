# Design Ideas & Hypotheses

> Cross-referencing ~150 HCI/CHI papers with the current app. Each idea is grounded in specific research. Organized from highest-impact to exploratory.

---

## A. Structural & Flow Redesigns

### A1. The Martini Glass: Two-Phase Review Flow

**Research basis:** Segel & Heer (InfoVis 2010) showed the martini glass is optimal — guided stem → free exploration bowl. Conlen et al. (EuroVis 2019) found readers do a "scouting scan" first across 50,000+ sessions. Uwano et al. (2006) proved initial full scan predicts defect-finding speed.

**Current state:** The app is pure linear scroll. There's no distinct "first pass" vs "deep review" phase.

**Idea:** Split the review into two explicit phases:

1. **The Fly-Over** (30 seconds): An auto-generated 1-screen overview showing every file as a colored tile (size = lines changed, color = importance). The reviewer scans the landscape. Maybe animated — files group themselves into the narrative sections in real-time, showing the AI's logic for grouping. Clicking any tile drops you into phase 2 at that point.

2. **The Walkthrough** (main review): The current linear narrative, but now the reviewer arrives having already seen the whole shape.

**Hypothesis:** Reviewers who see the full change landscape before reading the narrative will mark higher confidence in their reviews and spend more time on genuinely critical sections.

---

### A2. Focus Mode: One Section at a Time

**Research basis:** Mayer's Segmenting Principle — learner-controlled segments outperform continuous presentation (23/23 experiments). CrossCode (CHI 2023) showed multi-level abstraction beats monolithic views. Gonçalves et al. (ICPC 2025) found reviewers use "chunking" strategies.

**Current state:** All sections render in one long page. For a 15-section walkthrough of a large PR, the page is very tall.

**Idea:** Add a "Focus Mode" toggle that shows one section at a time, like slides. Navigation: left/right arrows, or the TOC becomes a tabbed sidebar. Each section fills the viewport. The TOC sidebar shows all sections with review state, acting as both navigation and progress tracker.

**Key design tension:** Focus mode risks losing context of the whole. Solution: keep the minimap visible as overview, and show a "section X of N" breadcrumb with neighboring section titles.

---

### A3. Importance-Based Progressive Disclosure

**Research basis:** TASSAL auto-folding (Fowkes et al., TSE 2016) — 28% error reduction with automatic code folding based on salience. Fisheye views (DeLine et al., CHI 2006) — significant speed improvement for understanding distant code. Furnas' DOI function (CHI 1986).

**Current state:** All hunks within a section render expanded by default. The importance badges exist but don't affect initial visibility.

**Idea:** Respect importance for initial expand/collapse state:
- `critical` + `important`: expanded, full diff visible
- `supporting`: collapsed to a 1-line summary ("Updated 3 import statements")
- `context`: hidden behind a "Show context" link
- `bulk`: grouped into a single expandable cluster

The reviewer *can* expand everything, but the default view guides their attention to what matters. Track how many expand supporting/context — if they expand everything, the tool learns to show more next time.

**Prompt change:** Ask the AI to be more aggressive about classifying importance. Currently most hunks are "important" — push for more variation.

---

### A4. Reverse the Default: Show Remaining Changes FIRST in the TOC

**Research basis:** Fregnan et al. (ESEC/FSE 2022, Distinguished Paper) — files shown first get 64% more defect detection. Currently "Remaining Changes" appears last, which means reviewers are least attentive when they reach the un-narrated code.

**Idea:** Don't put remaining changes at the bottom. Instead:
- Show a "Files not in walkthrough" counter prominently in the header (currently just a small coverage-bar)
- After the overview but before sections, show a collapsed "Quick Coverage Check" with the full file list. Each file links to where it appears in the walkthrough OR to the remaining section.
- Or: interleave remaining files into the relevant narrative sections based on directory proximity

---

## B. Reading Tracking & Attention

### B1. Read Wear on the Minimap

**Research basis:** Hill et al. (CHI 1992) — seminal "edit wear and read wear" concept. Visualize reading history as heatmap in scrollbar. Cockburn et al. (ACM Computing Surveys 2008) — overview+detail consistently outperforms linear scrolling.

**Current state:** The minimap shows tiny colored dots (reviewed = green, unreviewed = gray). Very small, right-edge only. No viewport tracking.

**Idea:** Replace the simple minimap with a "read wear" scrollbar:
- A vertical bar on the right showing all sections proportionally
- Color intensity indicates viewport dwell time (darker = more time spent)
- Unvisited regions pulse subtly or have a dotted texture
- The current viewport position is shown as a bright highlight
- Clicking anywhere jumps to that position

Technically: track `IntersectionObserver` on each section and hunk, accumulate viewport time, render as a heatmap on the scrollbar.

**The killer feature:** After reviewing, the minimap shows a clear picture of "here's where I spent time, here's what I skimmed." Forces the reviewer to confront their own coverage gaps.

---

### B2. "Jump to Next Unreviewed" with Satisfaction-of-Search Nudge

**Research basis:** Satisfaction of Search from radiology — after finding one issue, 22% of subsequent items are missed. Begel & Vrzakova (2018) distinguished skimming vs careful reading in code review.

**Current state:** There's a keyboard shortcut (j/k) to navigate sections, but no "jump to next unreviewed" (planned but not built).

**Idea:** After the reviewer marks a section as reviewed *and* has left a comment, show a brief nudge: "3 sections remaining — continue?" with a button that jumps to the next unreviewed section. This prevents the natural "I found something, I'm done" dropout.

Additionally: if viewport tracking shows a section was visible for <3 seconds before being marked "reviewed", show a gentle "Are you sure? This section was on screen for only 2 seconds" confirmation.

---

### B3. Estimated Review Time Per Section

**Research basis:** Medium's "X min read" increases completion rates by up to 40%. Mayer's Segmenting Principle — bounded units are less overwhelming. Topete et al. (2024) — framing progress as bounded reduces anxiety.

**Current state:** No time estimates anywhere.

**Idea:** In the TOC and section headers, show estimated review time:
- Compute from diff line count + narrative word count
- "~2 min" for a small section, "~8 min" for a large one
- Total at the top: "Estimated review time: ~25 minutes"
- As reviewer progresses: "~12 minutes remaining"

This transforms the unbounded "how long will this take?" into a manageable commitment.

---

## C. Narrative & Explanation Quality

### C1. Seven Explanation Types in Annotations

**Research basis:** Alotaibi et al. (TOSEM 2024) — identified 7 explanation types in code reviews: Rule/Principle, Similar Examples, Test Scenarios, Future Implications, Personal Preference, Issue Statement, Suggestion Benefit. Currently 42% of review comments have no explanation at all.

**Current state:** Annotations are free-text. The AI writes whatever it wants.

**Prompt change:** Instruct the AI to explicitly vary its explanation types across annotations:
- For security/correctness hunks: Rule/Principle ("This follows the principle of least privilege")
- For architectural choices: Similar Examples ("This mirrors how we handle X in Y")
- For tradeoffs: Future Implications ("If traffic grows 10x, this queue-based approach...")
- For test-related changes: Test Scenario ("This ensures the edge case where...")

Add a visual tag to each annotation showing its explanation type, so reviewers can scan for the type they need.

---

### C2. "Ask About This Code" — Inline Q&A

**Research basis:** Ko & Myers (CHI 2004/2009) — the Whyline reduced debugging time by 8x by reframing from forward-stepping to question-answering. The WirelessCar study (2025) found both proactive (upfront summary) and reactive (on-demand chat) modes are needed.

**Current state:** The walkthrough is fully pre-generated. No interactivity with the AI.

**Idea:** Add a small "?" button on each hunk or annotation. Clicking opens a context-aware chat panel seeded with:
- The specific code being viewed
- The walkthrough narrative
- The full diff for reference

The reviewer can ask: "What happens if this throws?", "Is this change backward compatible?", "Show me the call sites for this function."

**Implementation:** Stream responses directly in the app via Claude API. Use the hunk's code + surrounding context as prompt context.

---

### C3. Bidirectional Highlighting Between Narrative and Code

**Research basis:** Mayer's Spatial Contiguity Principle (22/22 experiments, effect size 1.10) — corresponding words and pictures near each other improve learning. Kim et al. (CHI 2021) — narrative must align with visual prominence. NL Outlines (Google, FSE 2025) — bidirectional sync between prose and code.

**Current state:** Annotations appear above their diff hunks but there's no visual link between specific words in the narrative and specific lines in the code.

**Idea:** When the narrative mentions a function name, variable, or concept that appears in the code below, highlight both on hover. The annotation text `"The new `validateInput` function checks..."` would highlight `validateInput` in both the narrative and the diff when hovered.

Implementation: Parse narrative for backtick-wrapped identifiers, cross-reference with diff line content, add data attributes for hover-linked highlighting.

---

### C4. Narrative Adapts to PR Type

**Research basis:** Gonçalves et al. (ICPC 2025) — four review scoping patterns: full, focused, partial, shallow. Different PR types warrant different review depths.

**Current state:** Same prompt and narrative structure for all PRs.

**Prompt change:** Detect PR type and adjust narrative structure:
- **New feature:** Start with motivation/user story → architecture diagram → types → core logic → wiring → UI → tests
- **Bug fix:** Start with the bug description → reproduction → root cause → fix → verification → regression considerations
- **Refactoring:** Start with before/after comparison → motivation for refactoring → file-by-file walkthrough → behavioral equivalence argument
- **Dependency update:** Risk assessment → breaking changes → migration notes → test verification
- **Large PR (>500 lines):** Executive summary → critical path (must-read) → completionist path (everything) → mechanical changes appendix

---

### C5. Commit-Based Chunking Option

**Research basis:** Gonçalves et al. (ICPC 2025) found some reviewers prefer commit-based chunking — reviewing one commit at a time. Stacked diffs (Phabricator/Graphite) treat each commit as separately reviewable.

**Current state:** The walkthrough treats the entire PR diff as one unit. Commit structure is lost.

**Idea:** Fetch individual commits and offer two walkthrough modes:
1. **By narrative** (current): AI groups changes by topic across commits
2. **By commit**: Each commit becomes a section with its own narrative, preserving the author's intended sequence

For commit-based mode, the AI gets both the commit message and the diff per commit, producing a walkthrough that follows the author's development story.

---

## D. Diff Rendering Innovations

### D1. Refactoring Detection Overlay

**Research basis:** RefactoringMiner 2.0 (TSE 2020) — detects 40 refactoring types. RefactorInsight (ASE 2021) — auto-folds refactoring changes in diffs. GitClear — 22-29% fewer lines to review with move/rename detection.

**Current state:** All diff lines shown with equal weight. Renames/moves appear as full add+delete pairs.

**Idea:** Ask the AI to detect and label refactoring operations in its analysis:
```json
{
  "refactorings": [
    { "type": "rename", "from": "oldName", "to": "newName", "files": ["a.ts", "b.ts"] },
    { "type": "extract_function", "name": "calculateTotal", "from": "processOrder", "file": "order.ts" },
    { "type": "move", "symbol": "UserType", "from": "types.ts", "to": "models/user.ts" }
  ]
}
```

In the viewer, refactoring changes collapse to a single descriptive line: "Renamed `oldName` → `newName` across 5 files" with expand-to-verify.

---

### D2. Augmented Diff Gutters

**Research basis:** Seesoft (Eick et al., 1992) — color-coded line decorations. OPERIAS (FSE 2016) — coverage overlay on diffs. The wide-open "augmented diff" design space.

**Current state:** Diffs show standard green/red with line numbers.

**Idea:** Add optional gutter decorations to diff lines:
- **Comment indicator:** A small 💬 icon on lines that have GitHub comments
- **Importance dot:** A colored dot matching the hunk's importance level
- **Cross-reference arrow:** Lines that are referenced by other hunks in the walkthrough get a small "→" icon linking to the other reference
- **"New to you" marker:** Lines that changed since the reviewer's last review (for re-reviews) get a highlight

---

### D3. Diff Minimap Per File

**Research basis:** Cockburn et al. (ACM Computing Surveys 2008) — overview+detail beats everything. Code Thumbnails (DeLine & Czerwinski, 2001) — miniaturized file views became VS Code's minimap.

**Current state:** Hunks have a max-height of 700px with scroll. For long files, the reviewer scrolls within the hunk container with no overview.

**Idea:** For hunks taller than ~40 lines, show a thin vertical minimap on the right side of the diff container. Green/red stripes show where changes are. The reviewer can click the minimap to jump within the diff.

---

## E. Collaboration & GitHub Integration

### E1. Reviewer Activity Awareness

**Research basis:** Gutwin & Greenberg (JCSCW 2002) — who, what, where, when, how awareness elements. Erickson & Kellogg (TOCHI 2000) — social translucence. Current tools support almost none of these.

**Current state:** The tool shows existing review comments and review states (approved/changes requested) but no awareness of who has reviewed what.

**Idea:** Fetch the PR's review request and activity data. Show:
- In the TOC: "Kim reviewed sections 1-4", "Alex is reviewing" (if there's recent activity)
- Per section: A small avatar/initials badge showing which reviewers have commented on files in this section
- A "Review Coverage Map" showing files × reviewers matrix

This helps when multiple reviewers split a large PR — you can see what's been covered.

---

### E2. Draft-then-Publish Comments (Google Critique Pattern)

**Research basis:** Google Critique — comments are drafted inline as-you-go but published atomically, preventing premature back-and-forth.

**Current state:** Comments post immediately to GitHub when submitted.

**Idea:** Queue comments locally as "drafts" (yellow highlight, shown only to you). A "Publish All Drafts" button submits them as a single review with all comments attached. This matches the GitHub "pending review" model but with better UX — you see your drafts in context as you read.

**Bonus:** Show draft count in the toolbar: "3 drafts pending"

---

### E3. Comment Anchoring to Walkthrough Sections

**Research basis:** Churchill et al. (CHI 2000) — anchored conversations spatially tied to documents. Annotation taxonomy (2024) — "annotation orphaning" is a key unsolved problem.

**Current state:** Comments are anchored to file+line (GitHub's model). But the walkthrough groups code by narrative section, not by file.

**Idea:** When the reviewer writes a comment, it's anchored to both:
- The GitHub file+line (for posting to GitHub)
- The walkthrough section (for local display)

Comments on the same file but different sections appear in their respective sections, not all lumped together. This makes comments flow with the narrative.

---

## F. Generation & Prompt Improvements

### F1. Two-Pass Generation: Structure Then Narrate

**Research basis:** ClusterChanges (Barnett et al., ICSE 2015) — decompose first, then review. DiagrammerGPT (COLM 2024) — plan-generate-refine is more accurate than direct generation.

**Current state:** Single API call generates the entire walkthrough JSON.

**Idea:** Split generation into two passes:

**Pass 1 (fast, cheap):** Classify and cluster. Send the diff to a fast model (Haiku) to:
- List all files with type (new/modified/deleted/renamed)
- Detect refactoring operations
- Group files into clusters by dependency/relatedness
- Classify each file's importance
- Detect PR type (feature/bugfix/refactor/etc.)

**Pass 2 (deep, expensive):** Narrate. Send the clusters + diff to Sonnet to:
- Generate narrative for each cluster (now a section)
- Generate the overview and architecture diagram
- Add annotations to specific line ranges

Benefits: Better coverage (Pass 1 ensures every file is classified), better narrative (Pass 2 focuses on writing, not organizing), ability to use cheaper model for the mechanical work.

---

### F2. Streaming Walkthrough Generation

**Research basis:** Industry standard for LLM UX. Reduces perceived latency dramatically.

**Current state:** CLI-only generation, writes JSON to disk, then viewer reads it. Typical generation takes 30-60 seconds with no feedback.

**Idea:** In-browser generation with streaming:
- User pastes PR URL → app fetches PR data → streams walkthrough from Claude API
- Each section appears as it's generated (incremental JSON parsing)
- The overview + architecture diagram appear first, then sections stream in one by one
- The reviewer can start reading section 1 while sections 2-N are still generating

This fundamentally changes the UX from "generate then review" to "review as it generates."

---

### F3. Context-Aware Prompt with Codebase Knowledge

**Research basis:** "From Overload to Insight" (Rao et al., FSE 2025) — LLMs can bridge the gap between code search and review context. CodeMap (ICPC 2026) — cognitive-aligned codebase visualization.

**Current state:** The prompt receives only the diff and PR metadata. The AI has no knowledge of the surrounding codebase.

**Idea:** Augment the prompt with:
- README/ARCHITECTURE.md from the repo (for domain context)
- File tree of the repo (so the AI understands where files sit)
- Type definitions / interfaces referenced in the diff but not changed
- Git log of recently merged PRs (for change velocity context)

This lets the AI write more insightful narratives: "This change adds rate limiting to the same endpoint that PR #142 added caching to last week" or "The `UserService` class this modifies is the most-changed file in the repo."

---

### F4. Explicit Coverage Enforcement in Prompt

**Current state:** The prompt says "file_map MUST list EVERY file" but the actual sections only cover 60-70% of files.

**Prompt change:** Add a structured step:

```
IMPORTANT: Before writing sections, enumerate EVERY file in the diff and assign
each to exactly one section. Output this mapping as a `file_assignments` object
BEFORE writing the sections. Every file must appear. Files with mechanical/trivial
changes can be assigned to a "remaining" section, but they must be explicitly
assigned. I will verify this.
```

Then in the viewer, validate: any file not in a section or file_assignments gets auto-added to remaining changes with a warning.

---

## G. Engagement & Active Review

### G1. Prediction Prompts

**Research basis:** Naps et al. (2002) Engagement Taxonomy — "responding" (answering questions) is more effective than "viewing." Hundhausen et al. (2002) meta-analysis — passive viewing has negligible learning benefit.

**Idea:** Before revealing a section's code, show a brief prediction prompt based on the narrative:

> "The narrative mentions adding rate limiting middleware. Before viewing the code, which approach would you expect?
> A) Token bucket in Redis  B) Sliding window in memory  C) Third-party middleware  D) Something else"

After the reviewer clicks an option (or skips), the code is revealed. This forces active engagement rather than passive scrolling.

**Implementation:** Add a `prediction` field to sections in the walkthrough JSON:
```json
{
  "prediction": {
    "question": "How would you expect the rate limiter to be implemented?",
    "options": ["Token bucket in Redis", "Sliding window in memory", "Third-party package"],
    "insight": "The author chose a sliding window — here's why..."
  }
}
```

---

### G2. Tradeoff Annotations as Decision Trees

**Research basis:** Interactive explanation interfaces outperform linear text — iGraph achieved 85.6% error detection vs 73.5% for standard text (Zhou et al., 2025). Code review as decision-making (EMSE 2025) — review is a question-asking/answering workflow.

**Current state:** Tradeoff callouts are static text blocks.

**Idea:** Render tradeoff callouts as interactive decision trees:

```
This uses an in-memory cache.
├─ Tradeoff: Speed vs Consistency
│  ├─ Chosen: In-memory (fast, but lost on restart)
│  ├─ Alternative: Redis (durable, but +20ms latency)
│  └─ Alternative: DB cache (consistent, but slower)
└─ Risk: Memory growth under high load
   └─ Mitigation: LRU eviction (configured at line 45)
```

Expandable nodes. Clicking "Alternative: Redis" could show what the code would look like with that approach. This makes tradeoffs tangible.

---

### G3. Review Checklist per Section

**Research basis:** Baum et al. (EMSE 2022) — checklists significantly lower cognitive load in complex reviews. Fagan (1976) — structured inspection with defined concerns.

**Idea:** Each section gets an auto-generated mini-checklist based on its content:

For a section about auth changes:
- [ ] Error paths return appropriate status codes
- [ ] Tokens are validated before use
- [ ] No sensitive data in logs

For a section about database changes:
- [ ] Migrations are reversible
- [ ] Indexes exist for new queries
- [ ] N+1 queries avoided

The AI generates these based on the section content and file types. They appear as a small expandable panel below the section header.

---

## H. Visual & Layout

### H1. Reading Path Visualization

**Research basis:** Hullman et al. (InfoVis 2013) — parallelism in sequence reduces cognitive cost. Data comics (Bach et al., CHI 2018) — spatial overview + linear narrative.

**Idea:** In the overview section, show a visual "reading path" — a small diagram showing how the sections connect:

```
Types ──→ Core Logic ──→ API Layer ──→ UI
  │            │              │
  └── shared types ──────────┘
```

This gives the reviewer a map of the journey before they start. The walkthrough narrative follows this path. Unreviewed sections glow. Reviewed sections dim.

---

### H2. Split-Pane: Narrative Left, Code Right

**Research basis:** Mayer's Spatial Contiguity (effect size 1.10) — corresponding content should be adjacent. Ivie (CHI 2024) — anchored explanations beat separate panels.

**Current state:** Narrative appears above code within each section. For long narratives, the code is pushed down out of view.

**Idea:** For wider viewports (>1400px), offer a split-pane layout: narrative text on the left (40% width), code diffs on the right (60% width). As the reviewer scrolls the narrative, the code pane auto-scrolls to show the relevant hunk. The narrative becomes a live reading companion.

This is similar to the Docco/Marginalia pattern but applied to diffs instead of source files.

---

### H3. Section Transition Animations

**Research basis:** Scrollytelling scores better on engagement (ECCE 2023). ScrollyVis (IEEE TVCG 2022) — visual continuity during scroll.

**Idea:** When scrolling between sections, show a subtle transition:
- The section number and title slide up as a sticky header for a moment
- The diagram (if any) fades in from the side
- Critical hunks slide in from the right, supporting hunks from the bottom

Keep animations minimal (200ms) and disable-able. The goal is to reinforce the narrative structure, not to be flashy.

---

## I. Hypotheses to Test

These are specific, testable predictions from the research:

| # | Hypothesis | Based on | How to test |
|---|---|---|---|
| H1 | Showing estimated review time increases review completion rate | Medium research | A/B test with/without time estimates |
| H2 | Importance-based collapse reduces review time by 15%+ without reducing defect detection | TASSAL, Fisheye research | Compare review times/quality with all-expanded vs importance-collapsed |
| H3 | Bidirectional highlighting between narrative and code increases comprehension accuracy | Mayer Spatial Contiguity, Ivie | Comprehension quiz after review |
| H4 | The "scouting fly-over" increases reviewer confidence | Uwano scan-time, Segel & Heer | Post-review confidence survey |
| H5 | Narrative walkthroughs make reviewers overestimate their understanding | GenAI/critical thinking (CHI 2025) | Compare self-reported vs actual comprehension |
| H6 | Two-pass generation achieves >95% file coverage vs ~65% for single-pass | ClusterChanges principle | Measure file coverage across N PRs |
| H7 | Draft-then-publish commenting leads to higher quality review comments | Google Critique pattern | Comment quality rating |
| H8 | Read-wear minimap causes reviewers to return to skimmed sections | Hill et al., SOS literature | Track post-minimap-view navigation |
| H9 | Per-section checklists reduce "LGTM" reviews for complex PRs | Baum 2022 checklist study | Measure review comment count/quality |
| H10 | Commit-based chunking is preferred for sequential development; topic-based for parallel | Gonçalves chunking strategies | User preference survey |

---

## J. Quick Wins (Low-effort, research-backed)

These can be implemented quickly with outsized impact:

1. **Add "N min read" to each section in the TOC** (bounded progress framing)
2. **Auto-collapse `supporting` and `context` hunks** (progressive disclosure)
3. **Add `n` keyboard shortcut to jump to next unreviewed** (already planned)
4. **Show file count in section headers** ("3 files") for scanning
5. **Add a "Review complete — submit?" prompt when all sections are checked** (completion incentive)
6. **Sort remaining files by size (lines changed) descending** (fight the file-order bias)
7. **Show comment count per section in the TOC** ("Section 3 💬2")
8. **Add reviewer name(s) from PR metadata to header** (social accountability)
9. **Add `?` keyboard shortcut showing all shortcuts** (already planned)
10. **Persist collapsed/expanded state in localStorage alongside review state**
