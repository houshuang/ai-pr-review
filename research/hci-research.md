# HCI Research: Innovative Interfaces for Code Review, Code Explanation & Understanding

> Compiled 2026-03-10. ~150 papers from CHI, UIST, CSCW, ICSE, FSE, VL/HCC, ETRA, MSR, VISSOFT, and related venues.

## Table of Contents

1. [Design Principles (Synthesis)](#design-principles)
2. [Cognitive Models of Program Comprehension](#cognitive-models)
3. [Code Review: Empirical Studies](#code-review-empirical)
4. [Code Review: Interface Innovations](#code-review-interfaces)
5. [AI-Augmented Code Understanding](#ai-augmented)
6. [Narrative & Storytelling for Technical Content](#narrative)
7. [Diff Visualization Innovations](#diff-visualization)
8. [Code Explanation & Algorithm Visualization](#code-explanation)
9. [Reading Tracking & Attention](#reading-tracking)
10. [Overview+Detail & Progressive Disclosure](#overview-detail)
11. [Collaborative Review & Annotation](#collaborative)
12. [Literate Programming & Computational Notebooks](#literate)
13. [Identified Research Gaps](#gaps)

---

## Design Principles

Synthesized from ~150 papers. These are the strongest, most replicated findings relevant to an AI-narrated code review walkthrough tool.

### The Big 10

1. **Narrative improves accuracy, not speed.** Data stories significantly improve comprehension accuracy (median 0.889 vs 0.667, p<0.0001) but don't make reading faster. The walkthrough will help reviewers *understand* better, not *review* faster. (Hasan et al., CHI 2024)

2. **Use the martini glass structure.** Start with a linear author-driven narrative (the stem), then open into free reader exploration (the bowl). Neither pure guidance nor pure exploration is optimal alone. (Segel & Heer, InfoVis 2010)

3. **Overview+detail beats everything else.** Linear scrolling is the worst-performing interface in every comparison. Adding any overview mechanism (minimap, TOC, thumbnail) improves both navigation speed and comprehension quality. Essays written with overview+detail received higher grades. (Cockburn et al., ACM Computing Surveys 2008; Hornbaek et al., CHI 2001)

4. **File order creates 64% defect detection difference.** Files shown first in a PR receive significantly more review attention. Reviewers had 64% lower odds of finding a defect when its file was last vs. first. Never use alphabetical ordering. (Fregnan et al., ESEC/FSE 2022 — Distinguished Paper)

5. **Missing rationale is the #1 source of confusion.** The biggest pain point in code review is not understanding WHY a change was made. 42% of review comments contain only suggestions without explanations. (Ebert et al., EMSE 2021; Alotaibi et al., TOSEM 2024)

6. **Anchored annotations generate 4x more engagement than separated discussion.** Placing annotations at the exact point of relevance dramatically increases engagement vs. separate forums. (Zyto & Karger, CHI 2012 — NB system at MIT)

7. **Existing review comments help, not hurt.** Visible comments act as positive reminders rather than negative primers — they help subsequent reviewers find bugs they would otherwise miss. ~70% of participants are prone to availability bias, but the net effect is positive. (Spadini et al., ICSE 2020)

8. **Richer visualizations don't distract.** Despite developers' subjective expectation of visual overload, studies consistently show richer code presentations reduce task time without creating distraction. (Asenov et al., CHI 2016; Projection Boxes, CHI 2020)

9. **Reviewers who do an initial full scan find defects faster.** Eye tracking shows a critical "scan" phase: those who spend more time on an initial top-to-bottom overview subsequently find defects faster. (Uwano et al., 2006; Sharif et al., ETRA 2012)

10. **Code review is primarily about understanding, not defects.** While finding defects is the stated motivation, the dominant actual outcomes are knowledge transfer, team awareness, and alternative solutions. Tools should optimize for comprehension. (Bacchelli & Bird, ICSE 2013)

### Supporting Principles

- **Sequence parallel changes together.** Parallelism in sequence structure (repeating similar transition patterns) significantly improves memory and subjective ratings. (Hullman et al., InfoVis 2013 — Best Paper)
- **Align narrative with visual prominence.** If the diff visually screams about a large refactor, the narrative must address it. Readers focus on visual prominence regardless of text annotations. (Kim et al., CHI 2021)
- **Support the "scouting scan."** Readers scroll through quickly first to decide whether to engage deeply. Over 50,000 sessions analyzed. Make the walkthrough scannable with clear section headers. (Conlen et al., EuroVis 2019)
- **Provide spatial landmarks.** Readers construct mental representations encoding spatial location. Progress bars, section markers, and stable visual anchors compensate for lost physical page cues. (Topete et al., 2024)
- **Frame progress as bounded.** Displaying estimated reading/review time increases engagement by up to 40%. Transform unbounded anxiety into bounded decision. (Medium/industry research)
- **Assign individual reviewers, not teams.** The bystander effect reduces review latency by 11% when a specific person is assigned vs. a team. (Meta A/B tests, TOSEM 2023)
- **Satisfaction of search is real.** After finding one issue, probability of detecting subsequent issues drops dramatically (22% of diagnostic errors in radiology). Track whether reviewers returned to examine remaining sections after first comment. (Berbaum/Cain, radiology literature)
- **40% of large PRs can be decomposed.** Automatic partitioning into independent clusters based on def-use relationships makes reviews cognitively tractable. (Barnett et al., ICSE 2015 — Microsoft Research)
- **AI walkthroughs are preferred — until labeled.** When source is unknown, 71% prefer AI-generated responses. When AI origin is disclosed, preference shifts. Be transparent. (2025 study, n=846)

---

## Cognitive Models

### How Developers Build Mental Models of Code

| Model | Author(s) | Year | Key Idea |
|---|---|---|---|
| Top-down hypothesis | Brooks | 1983 | Form hypothesis about purpose, progressively refine by mapping domain→code |
| Plans & beacons | Soloway & Ehrlich | 1984 | Expert programmers recognize "beacons" that signal stereotypic code plans |
| Conjecture-based | Letovsky | 1986 | Build knowledge base + mental model via conjectures (hypotheses) that are verified/refuted |
| Integrated metamodel | Storey | 2006 | Real programmers switch fluidly between top-down, bottom-up, and opportunistic strategies |
| Code Review Comprehension Model | Gonçalves et al. | 2025 | Three phases: context building → code inspection → decision. Extends Letovsky to code review |

**Key insight:** The walkthrough narrative externalizes what these models show is internal — it provides the initial hypothesis (Brooks), names the plans and beacons (Soloway), pre-constructs the conjectures (Letovsky), and supports strategy-switching (Storey).

### What Makes Code Hard (Neuroscience)

- **fMRI evidence:** Code comprehension activates the *multiple demand network* (mathematical/logical reasoning), NOT language centers. It heavily taxes working memory. (Siegmund et al., ICSE 2014)
- **Textual size drives cognitive load.** Vocabulary size particularly burdens working memory. Code with strong semantic cues (beacons) shows lower brain activation. (Peitek et al., ICSE 2021 — Distinguished Paper)
- **Verification cost is underestimated.** Reading and validating AI output is a major, often overlooked cognitive cost. Design walkthroughs that are easy to verify. (Mozannar et al., CHI 2024)

### Questions Developers Ask

- **44 question types** in 4 categories: finding focus points → building on them → understanding subgraphs → understanding groups of subgraphs. Current tools poorly support categories 3-4. (Sillito et al., FSE 2006)
- **Hardest questions:** Design rationale (why?), change impact (what breaks?), intent (what should this do?). (LaToza & Myers, 2010)
- **21 information need types.** Most frequent: artifact awareness. Most *difficult*: design intent. (Ko et al., ICSE 2007)

### Information Foraging

Programmers follow "information scent" — cues in identifier names, code structure, and comments. When scent is strong, navigation is efficient; when weak or misleading, developers get lost. A narrative walkthrough provides *maximum information scent* by explicitly telling the reviewer where to look and why. (Lawrance & Burnett, CHI 2008/2010)

### Resumption After Interruption

Only 10% of programming sessions have coding activity within 1 minute of resumption. Developers actively seek *task context* cues to reconstruct mental models. A PR review is essentially an "interruption" — the walkthrough provides the context cues essential for quickly building understanding. (Parnin & Rugaber, 2011)

---

## Code Review: Empirical Studies

### Large-Scale Industrial Studies

**Google Critique** (Sadowski et al., ICSE-SEIP 2018)
9 million reviewed changes analyzed. Key interface innovations:
- **Attention Set**: Bold names indicating who must act next — "how did we get along without this?"
- **Draft-then-Publish**: Comments drafted inline, published atomically
- **File review checkboxes** that auto-clear when files are modified at a new snapshot
- **Move detection** distinguishing relocated code from rewritten code
- **Intraline character-level diffing** with word-boundary awareness
- Source: [sback.it/publications/icse2018seip.pdf](https://sback.it/publications/icse2018seip.pdf)

**Microsoft CodeFlow** (Czerwonka et al., ACM Queue 2018)
- Character-level comment anchoring (not just lines)
- Comments link to semantic positions, surviving across iterations ("comment drift" solved)
- Thread-level resolution
- Source: [queue.acm.org/detail.cfm?id=3292420](https://queue.acm.org/detail.cfm?id=3292420)

**Convergent Practices** (Rigby & Bird, ESEC/FSE 2013)
Despite different cultures (Google, Microsoft, AMD, Lucent, Apache, Linux, KDE), review parameters converge: small, frequent, few reviewers, fast turnaround.

**Review is Social** (Bacchelli & Bird, ICSE 2013)
Reviews provide knowledge transfer, team awareness, and alternative solutions more than defect detection. "Code and change understanding is the key aspect of code reviewing."

### What Makes Review Effective

- **Three metrics matter**: coverage, participation, reviewer expertise. All share significant links with post-release defect rates. (McIntosh et al., EMSE 2016)
- **27 competencies required** for effective code review, far beyond "reading code." (Greiler et al., CSCW 2023)
- **Working memory capacity** has a moderate association with finding delocalized defects. Current tools present files alphabetically, which is suboptimal. Optimal ordering = grouping by relatedness. (Baum et al., EMSE 2019)
- **Checklists lower cognitive load** significantly in complex reviews. (Baum et al., EMSE 2022)
- **Confusion reasons:** Missing rationale (most common), non-functional aspects, lack of familiarity. (Ebert et al., EMSE 2021)

### AI in Code Review

**Proactive vs. Reactive modes both needed** (WirelessCar/Chalmers, 2025): LLM-generated reviews upfront for large/unfamiliar PRs; on-demand chat for familiar code.

**AutoCommenter** (Google, ICSE 2024): AI comments appear inline alongside human comments. Thumbs up/down feedback. Covers 68% of frequently-referenced best practices.

**Post-review AI feedback** (2025, studied at ICLR): 27% of reviewers who received feedback updated reviews. Reviews became +80 words longer and more informative. Post-review timing avoids anchoring bias.

**Google's ML-resolved comments** (ICSE 2024): Generates concrete code edit suggestions from reviewer comments. Addresses 52% of comments at 50% precision. One-click applicable patches.

---

## Code Review: Interface Innovations

### Named Systems and Prototypes

| System | Innovation | Source |
|---|---|---|
| **ClusterChanges** | Auto-decomposes large diffs into independent reviewable clusters via def-use analysis. 40%+ of Microsoft PRs decomposable. | Barnett et al., ICSE 2015 |
| **ReviewVis** | Force-directed graph of classes/methods, color-coded by change status | Fregnan et al., JSS 2022 |
| **GETTY** | Mines likely invariants from old/new code, presents behavioral differences. Teams using it found bugs missed by standard tools. | Lahiri et al., ASE 2017 |
| **GANDER** | Real-time eye tracking triggers proactive assistance based on gaze fixation | Lund University, ETRA 2023 |
| **OPERIAS** | Four synchronized views overlaying test coverage on diffs | Oosterwaal et al., FSE 2016 |
| **ViDI** | 3D visualization of system architecture overlaid with static analysis results | Tymchuk et al., ICSME 2015 |
| **ExplorViz** | Software city metaphor: packages=districts, classes=buildings, pipes=method calls | Krause-Glau et al., 2024 |
| **CodePanorama** | Zoomed-out images of entire codebase for visual anomaly detection | ICPC 2022 |
| **Tricorder** | Analysis results as gray comment boxes in Critique; one-click fix; <5% false positive rate | Sadowski et al., ICSE 2015 |
| **RefactorInsight** | Labels diffs with detected refactoring ops; auto-folds refactoring changes | JetBrains Research, ASE 2021 |

### Key Design Patterns from Research

- **Stacked diffs** (Phabricator/Graphite): Each commit separately reviewable, independently mergeable. Visual stack showing dependency relationships.
- **Interactive diff optimization** (Yagi et al., 2024): Users co-create diffs by giving feedback ("these lines should match"). 92% of non-optimal diffs fixed with <4 feedback actions.
- **Shared gaze visualization** (Cheng et al., 2022): Two reviewers see each other's gaze in real-time. Borders highlight currently reviewed lines.

---

## AI-Augmented Code Understanding

### LLM-Powered Code Explanation

**Ivie: Lightweight Anchored Explanations** (CHI 2024)
The most directly relevant paper. Two granularity levels: expression-level (beneath code lines) and block-level (in right margin). Color-coded borders and leader lines maintain visual association.
- Comprehension: 90.2% vs 65% (chatbot baseline)
- All NASA-TLX dimensions significantly lower
- 28/32 participants preferred it over chat
- Five principles: Anchored, Lightweight (1-2 sentences), Easy to invoke, Easy to dismiss, Accessible anytime
- Source: [arxiv.org/abs/2403.02491](https://arxiv.org/abs/2403.02491)

**Natural Language Outlines for Code** (Google, FSE 2025)
NL outlines partition code into prose-annotated sections, literate-programming style. Bidirectional sync: modify code or NL, the other auto-updates. Case studies specifically in code review and malware detection. **Most directly parallel to the walkthrough concept.**
- Source: [arxiv.org/abs/2408.04820](https://arxiv.org/abs/2408.04820)

**Interactive Explanation Interfaces** (Zhou et al., 2025)
Three interface types for LLM reasoning: text (iCoT), code (iPoT), graph (iGraph).
Error detection: iGraph (85.6%) > iPoT (82.5%) > iCoT (80.6%) > standard CoT (73.5%). Graph-based is also fastest. **Structured > linear.**
- Source: [arxiv.org/abs/2510.22922](https://arxiv.org/abs/2510.22922)

**Uncertainty Highlighting** (Microsoft/Stanford, TOCHI 2024)
Highlighting tokens likely to be edited is far more useful than highlighting low-confidence tokens. Raw generation probability provides NO benefit.
- Source: [arxiv.org/abs/2302.07248](https://arxiv.org/abs/2302.07248)

### Developer-AI Interaction Patterns

**Two modes** (Barke et al., OOPSLA 2023): Acceleration mode (knows what to do, uses AI for speed) and exploration mode (unsure, uses AI to explore). Review walkthroughs serve exploration mode.

**Design space of 90 AI coding assistants** (Lau & Guo, VL/HCC 2025): 10 dimensions across UI, inputs, capabilities, outputs. Explainability is a first-class design dimension. Three evolutionary eras: autocomplete → chat → agent-based.

**Information overload risk** (Pail IDE, CHI 2025): Users struggle to keep up with LLM-generated content. Keep walkthroughs concise and progressive-disclosure-oriented.

### Trust

- **LLM confidence scores are poorly calibrated** for code summaries. Use Platt scaling for calibrated scores. (Spiess et al., 2024)
- **Explainable AI features are the most emphasized factor** for achieving trust. (Trust Terrain, 2025)
- **Gap between self-reported productivity gains and empirical measurements.** Continuous back-and-forth between own code and AI suggestions increases cognitive load. (SANER 2025)
- **GenAI creates "illusion of comprehensive understanding"** — 79% of knowledge workers report less effort for comprehension, but this may reduce critical thinking rigor. (CHI 2025)

---

## Narrative & Storytelling for Technical Content

### Foundational Frameworks

**Narrative Visualization: Telling Stories with Data** (Segel & Heer, InfoVis 2010)
Seven genres of narrative visualization. The **martini glass structure**: linear author-driven stem → free reader-driven bowl. Purely author-driven (no interaction) and purely reader-driven (no guidance) are both suboptimal.
- Source: [vis.stanford.edu/files/2010-Narrative-InfoVis.pdf](http://vis.stanford.edu/files/2010-Narrative-InfoVis.pdf)

**Sequence and Parallelism** (Hullman et al., InfoVis 2013 — Best Paper)
Parallelism in transition patterns significantly improves memory. Proposed objective function for minimizing cognitive cost of transitions. **Implication: group structurally similar changes in parallel sequences.**

**Data Storytelling Effectiveness** (Hasan et al., CHI 2024)
103 participants. Data stories improved accuracy (0.889 vs 0.667) for comprehension tasks. Benefits were **independent of visualization literacy** — narrative helps experts and novices alike.

### Scrollytelling

- Scores significantly better on perceived engagement for most metrics. Primary strength: invoking emotional response. Won't reduce confusion about complex logic. (ECCE 2023)
- Readers scroll through quickly first (scouting scan) to decide whether to engage. Over 50,000 sessions analyzed. (Conlen et al., EuroVis 2019)
- Data comics (structured panels) perceived as more engaging with greater recall than text. (Mittenentzwei et al., 2023)

### Annotation and Marginalia

**NB annotation system** (Zyto & Karger, CHI 2012): 91 MIT students produced 14,000+ annotations. **4x more comments** than the next fifty most active course discussion boards combined. Situating annotations at the exact point of relevance is the key.

**Design Patterns for Data Comics** (Bach et al., CHI 2018): Comics keep everything visible (unlike video) while providing guided narrative order. Patterns: temporal sequences, build-up panels, flashback, zoom, annotation overlays.

### Chart + Caption Interaction

When caption emphasizes a low-prominence visual feature, readers **ignore the caption** and report the high-prominence feature as their takeaway. Narrative text must align with visual prominence in the diff. (Kim et al., CHI 2021)

### Multimedia Learning (Mayer)

- **Signaling Principle**: Adding cues that emphasize key info improves learning (23/23 experiments, effect size 0.86)
- **Segmenting Principle**: Learner-controlled segments outperform continuous presentation
- **Spatial Contiguity Principle**: Words and pictures near each other improve learning (22/22 experiments, effect size 1.10)
- **Coherence Principle**: Excluding extraneous material improves learning (23/23 experiments, effect size 0.86)

---

## Diff Visualization Innovations

### Semantic / AST-Based Diffs

| Tool | Innovation | Year | Source |
|---|---|---|---|
| **ChangeDistiller** | Fine-grained AST change extraction with change taxonomy | 2007 | Fluri et al., TSE |
| **GumTree** | Two-phase AST matching (greedy top-down + bottom-up). De facto standard. | 2014 | Falleri et al., ASE |
| **GumTree 2.0** | Scalable AST differencing for real-world deployment | 2024 | Falleri et al., ICSE |
| **CLDiff** | Groups AST diffs into statement-level units, *links* related changes via 5 link types | 2018 | Huang et al., ASE |
| **BDiff** | Block-aware text differencing. Outperforms GPT-5-mini and Qwen3-32B at diffing. | 2025 | arXiv |
| **RMiner** | Combines refactoring detection with AST differencing | 2024 | Alikhanifard & Tsantalis, TOSEM |
| **Difftastic** | Tree-sitter-based structural diff for 30+ languages. 20k+ GitHub stars. | 2022 | Open source |

### Refactoring Detection

| Tool | Innovation | Year |
|---|---|---|
| **RefactoringMiner 2.0** | Detects 40 refactoring types. Transforms add/delete pairs into meaningful operations. | 2020, TSE |
| **RefactorInsight** | IntelliJ plugin: labels diffs with refactoring info, auto-folds refactoring changes | 2021, ASE |
| **CodeTracker** | Tracks code blocks through commit history with 99.5% precision through refactorings | 2024, TSE |

### Change Vocabulary

GitClear/Commit Cruncher extends the binary add/delete vocabulary to six operations: Added, Deleted, Updated, Moved, Find/Replaced, Copy/Pasted. 22-29% fewer changed lines. 23-36% reduction in review time.

### Evolution Visualization

| System | Innovation | Year | Venue |
|---|---|---|---|
| **Seesoft** | Files as columns, lines as thin colored rows. 50,000+ lines visible. | 1992 | Eick et al., TSE |
| **History Flow** | Time-sequence of document snapshots with author-colored flowing bands | 2004 | Viegas & Wattenberg, CHI |
| **CVSscan** | Entire file evolution across all versions simultaneously. Stable=bands, churning=fragments. | 2005 | Voinea et al., SoftVis |
| **Code Flows** | Structural elements (functions, classes) flowing through time — splits, merges, drift | 2008 | Telea & Auber, EuroVis |
| **Chronos** | "History slicing" — minimal set of modifications relevant to an arbitrary code segment | 2013 | Servant & Jones, VISSOFT |
| **Azurite** | Edit-level timeline (not just commits). Drag marker to scrub through keystroke history. | 2013 | Yoon & Myers, VL/HCC |

### Architectural Change Visualization

- **CodeCity** (Wettel & Lanza, ICSE 2008/2011): 3D city metaphor. Controlled experiment showed significant improvement in task correctness and speed.
- **Voronoi Treemaps** (Balzer et al., SoftVis 2005): Better aspect ratios than rectangular treemaps for hierarchical software structure.

### Key Findings

- **Refactoring is the biggest comprehension killer.** Rename/extract showing as dozens of unrelated add/delete pairs wastes enormous reviewer effort.
- **Decomposition helps more than better rendering.** Breaking a diff into logical units may matter more than rendering each unit better.
- **Augmentation with external data is underexplored.** Wide-open design space for overlaying coverage, type changes, performance data, complexity deltas.

---

## Code Explanation & Algorithm Visualization

### The Engagement Hypothesis

**Passive viewing of algorithm animations has negligible learning benefit.** What matters is HOW students use the technology — constructing, predicting, answering questions. (Hundhausen et al., 2002 meta-analysis; Naps et al., 2002 Engagement Taxonomy)

Engagement hierarchy: no viewing < viewing < responding < changing < constructing < presenting

**Implication for walkthroughs:** Don't just present narrative — prompt the reviewer to respond, predict, or verify.

### Explanation Interfaces

**Seven explanation types in code reviews** (Alotaibi et al., TOSEM 2024):
1. Rule/Principle
2. Similar Examples
3. Test Scenario
4. Future Implications
5. Personal Preference
6. Issue Statement (most common, 40%)
7. Suggestion Benefit (25%)

ChatGPT correctly generated the right type in 88/90 cases.

**Tutorons** (Head et al., VL/HCC 2015): Automatic micro-explanations of code snippets on web pages. Context-relevant, embedded, not separate documentation.

**The Whyline** (Ko & Myers, CHI 2004/2009): "Why did/didn't" question-driven debugging. Reduced debugging time by 8x. Key reframe: from forward-stepping to question-answering.

### Progressive Disclosure & Semantic Zoom

- **Shneiderman's mantra** (1996): "Overview first, zoom and filter, then details-on-demand"
- **Fisheye views for code** (DeLine et al., CHI 2006): 16 participants performed tasks significantly faster. Greatest benefit for tasks requiring understanding of distant but related code.
- **TASSAL auto-folding** (Fowkes et al., TSE/ICSE 2016): Automatic code folding based on topical salience. 28% error reduction. Strongly preferred by experienced developers.
- **CrossCode multi-level visualization** (Hayatpur et al., CHI 2023): Three patterns — aggregate operations, abbreviate repetitive operations, display execution overview. Participants better oriented vs. Python Tutor.

### Narrated Tutorial Authoring

- **Torii** (Head et al., CHI 2020 — Best Paper Nominee): Step-by-step tutorials with live links between narrative, code snippets, and outputs.
- **Colaroid** (Wang et al., CHI 2023 — Honorable Mention): Multi-stage tutorials with highlighted code diffs between stages. Advantages over video and web tutorials.
- **Subgoal labeling** (CodeTree, CSCW 2024; AlgoSolve, CHI 2022): Breaking code into purpose-labeled chunks significantly improves understanding.

---

## Reading Tracking & Attention

### Eye Tracking in Code Review

| Finding | Source |
|---|---|
| Initial full scan predicts defect-finding speed | Uwano et al., 2006; Sharif et al., ETRA 2012 |
| Experts read code non-linearly; novices read linearly | Busjahn et al., ICPC 2015 |
| Two modes: fast skimming vs. careful deliberation | Begel & Vrzakova, EMIP 2018 |
| Fixation duration on defect-containing lines is significantly longer | Sharif et al., ETRA 2012 |
| Attention switching decreases as mental model solidifies | Bednarik & Tukiainen, ETRA 2006 |

### Viewport Tracking as Proxy for Attention

**Viewport time** (duration a component is visible in display) is the best scalable proxy for eye tracking. Mouse position is a poor proxy during reading. Dwell time alone is insufficient — need viewport time + scroll velocity. (Lagun & Lalmas, WSDM 2016)

**Scroll velocity signals engagement.** Disengaged readers show faster, more irregular scrolling. Up to 70% accuracy classifying disengagement from scroll behavior alone. (Biedermann et al., LAK 2023)

### Edit Wear and Read Wear

**Seminal paper** (Hill et al., CHI 1992): Visualize document usage history in the scrollbar — count edits and reads per-line, display as histogram in scrollbar. The direct ancestor of code review coverage tracking.

### Attention Guidance

**Attention-Aware Visualizations** (Srinivasan et al., IEEE VIS 2024): Track what users have seen, highlight what they haven't. Three components: gaze measurement, attention accumulation with memory-decay, reactive display modification. Design tension: avoiding self-reinforcing loops where highlights attract attention that removes highlights.

**Highlighting under cognitive load** (HCEye, ETRA 2024): Dynamic highlighting remains attention-grabbing even under high cognitive load. But non-highlighted areas get less attention when load is high — risk of tunnel vision.

### Speed Reading: Cautionary Tales

- **RSVP/Spritz impairs comprehension** at >350 wpm. Suppresses parafoveal processing and regressions, both essential for understanding. (Benedetto et al., 2015)
- **Bionic Reading provides no benefit.** Bolding first half of words doesn't help any population. (Peer-reviewed studies, 2022-2024)
- **Do not force linear reading.** Any feature restricting free re-reading, skipping, and jumping will impair comprehension.

---

## Overview+Detail & Progressive Disclosure

### Comprehensive Review

**A Review of Overview+Detail, Zooming, and Focus+Context Interfaces** (Cockburn et al., ACM Computing Surveys 2008): Definitive taxonomy. Overview+detail consistently performs well because it preserves context while allowing focus. The overview panel serves both navigation and coverage awareness.

### Key Studies

- **Space-Filling Thumbnails** (Cockburn & Gutwin, CHI 2006): All pages as miniatures with no scrolling. Significantly faster than all other methods. Especially effective for revisitation.
- **Popout Prism** (Suh et al., CHI 2002): Keyword matches "pop out" on document thumbnails using perceptual highlighting.
- **Generalized Fisheye Views** (Furnas, CHI 1986): DOI = a priori importance − distance from focus. Foundational framework.
- **Speed-Dependent Automatic Zooming** (Igarashi & Hinckley, UIST 2000): Zoom out when scrolling fast, zoom in when slow. Users felt more oriented.

---

## Collaborative Review & Annotation

### Awareness Frameworks

- **Workspace Awareness** (Dourish & Bellotti, CSCW 1992): Passive awareness (arising from activity) is more useful than active/explicit management.
- **Awareness Elements** (Gutwin & Greenberg, JCSCW 2002): Who, what, where, when, how. Current review tools support almost none systematically.
- **Social Translucence** (Erickson & Kellogg, TOCHI 2000): Show *just enough* about reviewer activity to create gentle accountability without surveillance. "Translucence" not "transparency."

### Anchored Conversations

- **Application-independent anchoring** (Churchill et al., CHI 2000): Chat windows anchored into documents via push-pins. Conversations spatially tied to document locations.
- **Annotation taxonomy** (2024): Key unresolved challenge is maintaining annotation anchors when underlying content changes — "annotation orphaning."

### Reviewer Assignment

- **Bystander effect** (Meta, TOSEM 2023): Assigning one individual (not team) reduced review turnaround by 11%.
- **RevFinder** (Thongtanunam et al., SANER 2015): File-path-similarity-based recommendation. 87% top-10 accuracy.
- **16-66% of invited reviewers never respond** (EMSE 2017).

### Asynchronous Collaboration

- People average ~3 minutes on a task before switching. 57% of working spheres are interrupted. (Czerwinski et al., CHI 2004)
- Only 10% resume programming within 1 minute. Need review session history showing what was examined, commented on, and where reviewer left off. (Parnin & Rugaber, 2011)

---

## Literate Programming & Computational Notebooks

### Foundational

**Literate Programming** (Knuth, 1984): Programs as literature — narrative ordering for human comprehension rather than compiler order. Forces explicit statement of design rationale. The intellectual ancestor of code-review-as-narrative.

### Modern Research

- **"The Story in the Notebook"** (Kery et al., CHI 2018): Data scientists actively curate notebooks into narratives. Confirms interleaving narrative+code is natural.
- **"What's Wrong with Computational Notebooks?"** (Chattopadhyay et al., CHI 2020): 9 pain points. Key tension: exploration vs. explanation. The walkthrough addresses this by providing explanation separate from exploration artifacts.
- **Idyll** (Conlen & Heer, UIST 2018): Compile-to-web markup for reactive, interactive documents. Scroll triggers, reactive state, structured components.
- **Living Papers** (Heer et al., UIST 2023): Augmented articles spanning print, interactive, and computational media from single Markdown source.

---

## IDE Innovations for Code Understanding

| System | Innovation | Year | Venue |
|---|---|---|---|
| **Code Bubbles** | Function-level fragments on 2D canvas. Working sets of concurrently visible code. Faster understanding + fewer navigation interactions vs. Eclipse. | 2010 | CHI |
| **Code Canvas** | Infinite zoomable surface with semantic zoom. Leverages spatial memory. | 2010 | ICSE/CACM |
| **Mylyn** | Task-focused interface. DOI model based on recency/frequency filters irrelevant elements. Significant productivity improvement. | 2006 | FSE |
| **Stacksplorer** | Call graph visualization alongside editor. 3 of 4 maintenance tasks significantly faster. | 2011 | CHI |
| **Code Thumbnails** | Miniaturized file views in scrollbar. Eventually became the VS Code minimap. | 2001 | VL/HCC |
| **Catseye** | VS Code extension for persistent code annotations. Annotations anchored to multiple locations. | 2022 | UIST |
| **Meta-Manager** | Captures thought histories (questions, hypotheses, dead ends) as reusable meta-information. | 2024 | CHI |
| **CodeMap** | LLM-based codebase visualization aligned with human cognitive flow. 79% less reliance on text, 90% more map usage. | 2025 | ICPC |

---

## Identified Research Gaps

**No published research specifically on AI-generated narrative walkthroughs for code review.** The closest work is NL Outlines (Google, FSE 2025) which included a code review case study, and Ivie (CHI 2024) for AI-generated code explanations. Your tool sits in a genuinely novel intersection.

Other gaps:
- No formal usability study of code editor minimaps
- No direct study of "review coverage tracking" for code review
- No studies comparing narrative structures for code changes (chronological vs. dependency-ordered vs. importance-ordered)
- No research on cross-language diffs (TypeScript + SQL + Terraform in one PR)
- No research on AI-generated code diffs vs. human-authored diffs
- Real-time collaborative review interfaces (multiple simultaneous reviewers) essentially unstudied
- Comment drift in evolving content has no principled solution beyond iteration tracking
- Longitudinal studies of interface interventions are rare
- Accessibility in code review tools is unstudied
- The Naps engagement taxonomy has not been applied to code review

---

## Key References by Impact

### Must-Read (Directly Actionable)

1. Bacchelli & Bird, "Expectations, Outcomes, and Challenges of Modern Code Review" (ICSE 2013) — *Review is about understanding*
2. Fregnan et al., "First Come First Served" (ESEC/FSE 2022) — *File order = 64% defect detection difference*
3. Segel & Heer, "Narrative Visualization" (InfoVis 2010) — *Martini glass structure*
4. Yan et al., "Ivie: Lightweight Anchored Explanations" (CHI 2024) — *Anchored > chat for code explanation*
5. Shi et al., "Natural Language Outlines for Code" (FSE 2025) — *Closest parallel to the walkthrough concept*
6. Barnett et al., "ClusterChanges" (ICSE 2015) — *40% of PRs decomposable*
7. Gonçalves et al., "Code Review Comprehension Model" (ICPC 2025) — *How reviewers actually comprehend*
8. Hill et al., "Edit Wear and Read Wear" (CHI 1992) — *Coverage tracking on scrollbar*
9. Cockburn et al., "Overview+Detail Review" (ACM Computing Surveys 2008) — *Overview+detail beats all*
10. Ebert et al., "Confusion in Code Reviews" (EMSE 2021) — *Missing rationale = #1 confusion*

### Foundational (Theory)

- Soloway & Ehrlich, "Plans & Beacons" (1984) — Expert pattern recognition
- Letovsky, "Cognitive Processes" (1986) — Conjecture-based comprehension
- Storey, "Integrated Metamodel" (2006) — Strategy switching
- Shneiderman, "The Eyes Have It" (1996) — Overview first, zoom, details-on-demand
- Furnas, "Generalized Fisheye Views" (CHI 1986) — Degree of interest
- Knuth, "Literate Programming" (1984) — Programs as literature
- Lawrance & Burnett, "Information Foraging" (CHI 2008/2010) — Information scent
- Mayer, "Multimedia Learning Principles" (2001) — Signaling, segmenting, contiguity, coherence
