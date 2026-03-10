# User Intent — Original Vision

Captured from the initial conversation on 2026-03-10.

## The Problem

"I find it very difficult to read the diff in a GitHub diff viewer. I often don't know where to start. There's no narrative."

The user leads a team where:
- **Quality is taken seriously** — every reviewer reads the actual code
- **Reviewers take responsibility** — they don't delegate judgment to AI
- GitHub's diff viewer is insufficient: flat file list, no reading order, no narrative
- Existing AI review tools either summarize (losing code) or comment inline (not restructuring)

## The Vision

A tool that generates a **code walkthrough formed like a narrative**, structured for progressive understanding:

1. **Narrative structure** — The review is organized like a teaching document, not a flat list of files. Related changes across files are grouped. There's an introduction, a logical progression, and a conclusion.

2. **All code is present** — "Making sure that I actually see all of the code that I need to review." This is non-negotiable. The tool structures and annotates, but the reviewer reads every line.

3. **Explanation and diagrams** — Code groups come with AI-generated explanations of WHY the changes matter, how they connect, architecture diagrams, flow diagrams.

4. **Review tracking** — "Maybe I'm able to mark the ones I've seen." Per-section or per-hunk checkboxes. The reviewer can track their progress through the review.

5. **Update awareness** — "It should be able to update and show what's updated if I've approved one version and a new version comes." When the PR is force-pushed, show what changed since the last review.

6. **Context expansion** — "I should be able to expand up and down." See surrounding code beyond the diff hunks.

7. **Diff modes** — "I should be able to see a unified or a side-by-side diff."

8. **Navigation** — "Maybe I should be able to click on function definitions and go to them." Code intelligence within the review.

## Key Quotes

> "This is a company where we take quality seriously, and we take responsibility for our code reviews."

> "I have some skills that are amazing at generating incredibly detailed code walkthroughs, like the PR walkthrough. It's very pleasant to read."

> "I'm wondering if anyone has built, or if I should try to build, a tool that generates a code walkthrough that is formed like a narrative, structuring the code, showing things adjacent, grouped with narrative, explanation, diagrams, etc., all in one place, but making sure that I actually see all of the code that I need to review."

## Priority Order (Inferred)

1. **Complete code coverage** — ALL code must be visible and reviewable
2. **Narrative structure** — Logical reading order with explanations
3. **Review tracking** — Know what you've seen, what remains
4. **GitHub integration** — Comments, approvals, staying in sync
5. **Update awareness** — Handle force-pushes gracefully
6. **Context expansion** — See beyond the diff
7. **Code navigation** — Jump to definitions

## What This is NOT

- Not an AI-that-reviews-for-you tool
- Not a replacement for reading code
- Not a summary generator
- Not a linting/quality gate tool
- It is a **reading aid** — like how a good editor structures a textbook for progressive understanding, while the reader still reads every word

## Inspirations

- The pr-walkthrough skill output — "It's very pleasant to read"
- Stripe engineering blog aesthetic
- Well-written RFCs
- CodeSee Review Map Tours (manual narrative, closest existing concept)
- Reviewable (best review tracking, interdiff)
