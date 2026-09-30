import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff, filterFileToRanges } from "../src/diff.js";

const deleted = `diff --git a/a.js b/a.js
deleted file mode 100644
--- a/a.js
+++ /dev/null
@@ -1,10 +0,0 @@
${Array.from({ length: 10 }, (_, i) => `-export const value${i} = ${i};`).join("\n")}
`;

test("deleted-file sections retain their old-side annotated code in the viewer and export", () => {
  const ranges = [{ file: "a.js", startLine: 8, endLine: 10, annotation: "Remove exports", importance: "important" }];
  const filtered = filterFileToRanges(parseDiff(deleted)["a.js"], ranges);
  assert.equal(filtered.blocks.length, 1);
  assert.match(filtered.blocks[0].lines.at(-1).content, /value9/);
  const dir = mkdtempSync(join(tmpdir(), "review-deleted-export-"));
  try {
    const input = join(dir, "review.json"), output = join(dir, "review.html");
    writeFileSync(input, JSON.stringify({ meta: {}, diff: deleted, walkthrough: {
      title: "Remove values", overview: "Remove values", file_map: [],
      sections: [{ id: "deleted", title: "Deleted", narrative: "Remove exports", hunks: ranges, callouts: [] }],
      review_tips: [],
    }}));
    execFileSync(process.execPath, ["src/export-static.js", input, "--output", output], { encoding: "utf8" });
    assert.match(readFileSync(output, "utf8"), /value9/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
