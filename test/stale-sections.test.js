import { test } from "node:test";
import assert from "node:assert/strict";
import { changedPatchFiles, staleSectionFiles } from "../src/stale-sections.js";

const patch = (start, added) => `@@ -${start},2 +${start},3 @@\n context\n+${added}\n more context`;
const diff = (files) => Object.entries(files).map(([path, body]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`).join("");

test("a rebase that only moves lines or context is not a change to the PR's own patch", () => {
  const stored = diff({ "src/a.js": patch(10, "added"), "src/b.js": patch(1, "kept") });
  const now = [
    { filename: "src/a.js", patch: "@@ -40,2 +40,3 @@\n other context\n+added\n more" },
    { filename: "src/b.js", patch: patch(1, "rewritten") },
    { filename: "src/c.js", patch: patch(1, "new file") },
    { filename: "src/huge.js", patch: undefined },
  ];
  assert.deepEqual(changedPatchFiles(stored + diff({ "src/huge.js": patch(1, "x") }), now).sort(), ["src/b.js", "src/c.js"]);
});

test("sections are marked by the changed files their hunks show or their prose cites", () => {
  const walkthrough = { sections: [
    { id: "hunk", narrative: "", hunks: [{ file: "src/b.js", annotation: "" }], callouts: [] },
    { id: "cited", narrative: "Calls b.js:4 from elsewhere.", hunks: [{ file: "src/a.js", annotation: "" }], callouts: [] },
    { id: "base-only", narrative: "Before: base src/b.js:4.", hunks: [], callouts: [] },
    { id: "untouched", narrative: "", hunks: [{ file: "src/a.js", annotation: "" }], callouts: [] },
  ] };
  assert.deepEqual(staleSectionFiles(walkthrough, ["src/b.js"]), { hunk: ["src/b.js"], cited: ["src/b.js"] });
});
