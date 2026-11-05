import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/diff.js";
import { allocateFragments } from "../src/file-fragments.js";

const newFileDiff = (name, count) => `diff --git a/${name} b/${name}
new file mode 100644
--- /dev/null
+++ b/${name}
@@ -0,0 +1,${count} @@
${Array.from({ length: count }, (_, i) => `+line${i + 1}`).join("\n")}
`;

const hunk = (file, startLine, endLine, importance = "important", annotation = `about ${startLine}`) => ({ file, startLine, endLine, importance, annotation });

function allocate(diff, sections) {
  const files = parseDiff(diff);
  const allocation = allocateFragments(sections, (path) => files[path]);
  return { files, allocation, fragment: (path, id) => allocation.get(files[path])?.get(id) };
}

const shownLines = (fragment) => fragment.blocks.flatMap((block) => block.lines.map((line) => line.newNumber));

const modifiedDiff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,6 +1,6 @@
 one
 two
-old three
+new three
 four
 five
 six
@@ -40,3 +40,3 @@
 forty
-old forty-one
+new forty-one
 forty-two
@@ -80,3 +80,3 @@
 eighty
-old eighty-one
+new eighty-one
 eighty-two
`;

test("a new file cited by three sections is split so every line appears exactly once", () => {
  const { fragment } = allocate(newFileDiff("a.ts", 40), [
    { id: "one", hunks: [hunk("a.ts", 5, 10)] },
    { id: "two", hunks: [hunk("a.ts", 15, 20)] },
    { id: "three", hunks: [hunk("a.ts", 30, 32)] },
  ]);
  const seen = [...shownLines(fragment("a.ts", "one")), ...shownLines(fragment("a.ts", "two")), ...shownLines(fragment("a.ts", "three"))];
  assert.deepEqual(seen, Array.from({ length: 40 }, (_, i) => i + 1));
  assert.deepEqual(shownLines(fragment("a.ts", "two")), Array.from({ length: 15 }, (_, i) => i + 15));
  assert.match(fragment("a.ts", "two").blocks[0].header, /\+15,15 @@/);
  assert.deepEqual(fragment("a.ts", "two").others, ["one", "three"]);
});

test("a file cited by one section is left to the ordinary hunk filter", () => {
  const { allocation, files } = allocate(newFileDiff("a.ts", 40), [{ id: "one", hunks: [hunk("a.ts", 5, 10), hunk("a.ts", 20, 25)] }]);
  assert.equal(allocation.get(files["a.ts"]), undefined);
});

test("overlaps go to higher importance, then the narrower range, then the earlier section", () => {
  const important = allocate(newFileDiff("a.ts", 30), [
    { id: "context", hunks: [hunk("a.ts", 5, 10, "context")] },
    { id: "critical", hunks: [hunk("a.ts", 8, 20, "critical")] },
  ]);
  assert.ok(shownLines(important.fragment("a.ts", "critical")).includes(8));
  assert.ok(!shownLines(important.fragment("a.ts", "context")).includes(8));

  const narrow = allocate(newFileDiff("a.ts", 30), [
    { id: "broad", hunks: [hunk("a.ts", 1, 30)] },
    { id: "narrow", hunks: [hunk("a.ts", 10, 12)] },
  ]);
  assert.deepEqual(shownLines(narrow.fragment("a.ts", "narrow")).slice(0, 3), [10, 11, 12]);
  assert.ok(shownLines(narrow.fragment("a.ts", "broad")).includes(1));

  const same = allocate(newFileDiff("a.ts", 30), [
    { id: "first", hunks: [hunk("a.ts", 5, 10)] },
    { id: "second", hunks: [hunk("a.ts", 5, 10)] },
  ]);
  assert.equal(same.fragment("a.ts", "second").blocks.length, 0);
  assert.equal(shownLines(same.fragment("a.ts", "first")).length, 30);
});

test("a citation with no lines left keeps its annotation and points to the section showing it", () => {
  const { fragment } = allocate(newFileDiff("a.ts", 30), [
    { id: "first", hunks: [hunk("a.ts", 5, 10)] },
    { id: "second", hunks: [hunk("a.ts", 6, 8, "supporting", "subsumed"), hunk("a.ts", 20, 25, "supporting", "own lines")] },
  ]);
  const second = fragment("a.ts", "second");
  assert.deepEqual(second.elsewhere.map(({ hunk: item, sectionId }) => [item.annotation, sectionId]), [["subsumed", "first"]]);
  assert.deepEqual(second.placed.map((item) => item.annotation), ["own lines"]);
});

test("a section left with no lines keeps annotations that cite lines outside the diff", () => {
  const { fragment } = allocate(modifiedDiff, [
    { id: "real", hunks: [hunk("m.ts", 41, 41)] },
    { id: "gap", hunks: [hunk("m.ts", 43, 44, "important", "just past the block")] },
    { id: "lost", hunks: [hunk("m.ts", 500, 510, "important", "nowhere near")] },
  ]);
  const gap = fragment("m.ts", "gap");
  assert.deepEqual(gap.blocks, []);
  assert.deepEqual(gap.placed, []);
  assert.deepEqual(gap.elsewhere.map(({ hunk: item, sectionId }) => [item.annotation, sectionId]), [["just past the block", "real"]]);
  assert.equal(fragment("m.ts", "lost").elsewhere[0].hunk.annotation, "nowhere near");
});

test("a deletion stays with the insertion replacing it, and an uncited block stays unallocated", () => {
  const { fragment } = allocate(modifiedDiff, [
    { id: "top", hunks: [hunk("m.ts", 1, 2)] },
    { id: "change", hunks: [hunk("m.ts", 3, 3)] },
    { id: "far", hunks: [hunk("m.ts", 41, 41)] },
  ]);
  const content = (id) => fragment("m.ts", id).blocks.flatMap((block) => block.lines.map((line) => line.content.trim()));
  assert.deepEqual(content("top"), ["one", "two"]);
  assert.deepEqual(content("change"), ["-old three", "+new three", "four", "five", "six"]);
  assert.deepEqual(content("far"), ["forty", "-old forty-one", "+new forty-one", "forty-two"]);
  const shown = ["top", "change", "far"].flatMap(content);
  assert.ok(!shown.includes("+new eighty-one"));
});

test("each comment line belongs to one section, and lines outside the diff go to the first section", () => {
  const { fragment } = allocate(newFileDiff("a.ts", 30), [
    { id: "first", hunks: [hunk("a.ts", 5, 10)] },
    { id: "second", hunks: [hunk("a.ts", 20, 25)] },
  ]);
  for (const line of [7, 22, 500, null]) {
    const owners = ["first", "second"].filter((id) => fragment("a.ts", id).showsLine(line));
    assert.equal(owners.length, 1, `line ${line}`);
  }
  assert.ok(fragment("a.ts", "first").showsLine(500));
  assert.ok(fragment("a.ts", "second").showsLine(22));
});

test("the static export shows each line of a shared file once", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-fragments-export-"));
  try {
    const input = join(dir, "review.json"), output = join(dir, "review.html");
    writeFileSync(input, JSON.stringify({
      meta: {}, diff: newFileDiff("a.ts", 12).replaceAll(/line(\d+)/g, "uniquemarker$1end"),
      walkthrough: {
        title: "T", subtitle: "S", overview: "O", architecture_diagram: "", file_map: [], review_tips: [],
        sections: [
          { id: "first", title: "First", narrative: "N", callouts: [], hunks: [hunk("a.ts", 2, 3)] },
          { id: "second", title: "Second", narrative: "N", callouts: [], hunks: [hunk("a.ts", 8, 9)] },
          { id: "third", title: "Third", narrative: "N", callouts: [], hunks: [hunk("a.ts", 2, 3, "supporting", "repeat of first")] },
        ],
      },
    }));
    execFileSync(process.execPath, ["src/export-static.js", input, "--output", output, "--mode", "unified"]);
    const html = readFileSync(output, "utf8");
    for (let n = 1; n <= 12; n++) assert.equal(html.split(`uniquemarker${n}end`).length - 1, 1, `line ${n}`);
    assert.match(html, /repeat of first/);
    assert.match(html, /href="#section-first"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
