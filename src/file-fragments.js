const IMPORTANCE_RANK = { critical: 0, important: 1, supporting: 2, context: 3 };
const NEAR_BLOCK_MARGIN = 5;

const rank = (hunk) => IMPORTANCE_RANK[hunk.importance] ?? IMPORTANCE_RANK.important;
const lineNumber = (file, line) => (file.isDeleted ? line.oldNumber : line.newNumber);

function ownersOf(file, block, claims) {
  const numbers = block.lines.map((line) => lineNumber(file, line));
  const claimedAt = (margin) => numbers.map((number) => (number
    ? claims.find((claim) => number >= claim.start - margin && number <= claim.end + margin)?.sectionId
    : undefined));
  let owners = claimedAt(0);
  if (!owners.some(Boolean)) owners = claimedAt(NEAR_BLOCK_MARGIN);
  if (!owners.some(Boolean)) return null;

  // A deletion reads with the insertion that replaces it.
  for (let i = owners.length - 2; i >= 0; i--) {
    if (!numbers[i] && block.lines[i + 1].type !== "context") owners[i] = owners[i + 1];
  }
  // Uncited lines stay with their neighbour, so splitting a file never drops a changed line.
  for (let i = 1; i < owners.length; i++) owners[i] ??= owners[i - 1];
  for (let i = owners.length - 2; i >= 0; i--) owners[i] ??= owners[i + 1];
  return owners;
}

function sliceBlock(block, lines) {
  if (lines.length === block.lines.length) return block;
  const oldNumbers = lines.map((line) => line.oldNumber).filter(Boolean);
  const newNumbers = lines.map((line) => line.newNumber).filter(Boolean);
  const oldStartLine = oldNumbers[0] ?? block.oldStartLine;
  const newStartLine = newNumbers[0] ?? block.newStartLine;
  return {
    ...block,
    lines,
    oldStartLine,
    newStartLine,
    header: `@@ -${oldStartLine},${oldNumbers.length} +${newStartLine},${newNumbers.length} @@`,
  };
}

function allocateFile(file, citations) {
  const claims = citations
    .flatMap(({ sectionId, order, hunks }) => hunks
      .filter((hunk) => hunk.startLine && hunk.endLine)
      .map((hunk) => ({ sectionId, order, rank: rank(hunk), start: hunk.startLine, end: hunk.endLine })))
    .sort((a, b) => a.rank - b.rank || (a.end - a.start) - (b.end - b.start) || a.order - b.order);

  const blocksBySection = new Map(citations.map(({ sectionId }) => [sectionId, []]));
  const numbersBySection = new Map(citations.map(({ sectionId }) => [sectionId, new Set()]));
  const ownerByLine = new Map();

  for (const block of file.blocks) {
    const owners = ownersOf(file, block, claims);
    if (!owners) continue;
    for (let start = 0, end; start < owners.length; start = end) {
      end = start + 1;
      while (end < owners.length && owners[end] === owners[start]) end++;
      const lines = block.lines.slice(start, end);
      blocksBySection.get(owners[start]).push(sliceBlock(block, lines));
      for (const line of lines) {
        const number = lineNumber(file, line);
        if (!number) continue;
        numbersBySection.get(owners[start]).add(number);
        ownerByLine.set(number, owners[start]);
      }
    }
  }

  const fragments = new Map();
  citations.forEach(({ sectionId, hunks }, index) => {
    const blocks = blocksBySection.get(sectionId);
    const numbers = numbersBySection.get(sectionId);
    const placed = [], elsewhere = [];
    for (const hunk of hunks) {
      const range = [];
      for (let line = hunk.startLine; hunk.startLine && line <= hunk.endLine; line++) range.push(line);
      const shownElsewhere = range.map((line) => ownerByLine.get(line)).find((owner) => owner && owner !== sectionId);
      if (shownElsewhere && !range.some((line) => numbers.has(line))) elsewhere.push({ hunk, sectionId: shownElsewhere });
      else placed.push(hunk);
    }
    // With no diff to anchor to, every annotation has to render on its own or it would vanish.
    if (!blocks.length) {
      const fallback = citations.find((citation) => blocksBySection.get(citation.sectionId).length)?.sectionId ?? null;
      elsewhere.push(...placed.splice(0).map((hunk) => ({ hunk, sectionId: fallback })));
    }
    const count = (type) => blocks.reduce((total, block) => total + block.lines.filter((line) => line.type === type).length, 0);
    fragments.set(sectionId, {
      file: { ...file, blocks, addedLines: count("insert"), deletedLines: count("delete") },
      blocks,
      others: citations.map((citation) => citation.sectionId).filter((id) => id !== sectionId && blocksBySection.get(id).length),
      placed,
      elsewhere,
      // A comment on a line outside the diff still needs one home: the first citing section.
      showsLine: (line) => numbers.has(line) || (index === 0 && !ownerByLine.has(line)),
    });
  });
  return fragments;
}

/**
 * Gives each changed line of a file cited by several sections to exactly one of
 * them, so a reader meets each line once while following the narrative. An
 * overlap goes to the more important citation, then the narrower one, then the
 * earlier section; a narrow citation inside a broad one keeps its own lines and
 * the broad one keeps the rest. Files cited by one section are not included.
 *
 * Returns Map<file, Map<sectionId, fragment>>.
 */
export function allocateFragments(sections, resolveFile) {
  const citationsByFile = new Map();
  (sections || []).forEach((section, order) => {
    for (const hunk of section.hunks || []) {
      const file = resolveFile(hunk.file);
      if (!file) continue;
      if (!citationsByFile.has(file)) citationsByFile.set(file, new Map());
      const citations = citationsByFile.get(file);
      if (!citations.has(section.id)) citations.set(section.id, { sectionId: section.id, order, hunks: [] });
      citations.get(section.id).hunks.push(hunk);
    }
  });

  const allocation = new Map();
  for (const [file, citations] of citationsByFile) {
    if (citations.size > 1) allocation.set(file, allocateFile(file, [...citations.values()]));
  }
  return allocation;
}

/** "L1–82, L90" for the lines a fragment shows. */
export function fragmentLineLabel(fragment) {
  return fragment.blocks.map((block) => {
    const numbers = block.lines.map((line) => lineNumber(fragment.file, line)).filter(Boolean);
    if (!numbers.length) return null;
    const first = numbers[0], last = numbers.at(-1);
    return first === last ? `L${first}` : `L${first}–${last}`;
  }).filter(Boolean).join(", ");
}
