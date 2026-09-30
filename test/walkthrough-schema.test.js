import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWalkthrough, validatePatch, diffInventory } from "../src/walkthrough-schema.js";

const diff = `diff --git a/a.js b/a.js
index 1111111..2222222 100644
--- a/a.js
+++ b/a.js
@@ -1,2 +1,2 @@
-const value = 1;
+const value = 2;
 export { value };
diff --git a/b.js b/b.js
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/b.js
@@ -0,0 +1 @@
+export const b = 3;
`;
const walkthrough = () => ({ title: "Title", subtitle: "Subtitle", overview: "Overview", architecture_diagram: "", sections: [{ id: "values", title: "Change values", narrative: "Explain", diagram: null,
  hunks: [{ file: "a.js", startLine: 1, endLine: 2, annotation: "Changes value", importance: "important" }], callouts: [] }], file_map: [{ path: "a.js", description: "Changes value", is_new: false }], review_tips: [] });

test("large raw diff hunks do not overflow the validator's call stack", () => {
  const large = `diff --git a/large.js b/large.js\nnew file mode 100644\n--- /dev/null\n+++ b/large.js\n@@ -0,0 +1,150000 @@\n${"+a\n".repeat(150000)}`;
  assert.deepEqual(diffInventory(large)[0].ranges, [{ start: 1, end: 150000 }]);
});

test("file coverage is derived from diff, including unnarrated new files", () => {
  const result = validateWalkthrough(walkthrough(), diff);
  assert.deepEqual(result.file_map.map(({path,is_new}) => ({path,is_new})), [{path:"a.js",is_new:false},{path:"b.js",is_new:true}]);
});

test("nonexistent files, invalid lines, enum values and duplicate IDs fail validation", () => {
  for (const mutate of [w => {w.sections[0].hunks[0].file = "made-up.js";}, w => {w.sections[0].hunks[0].endLine = 500;}, w => {w.sections[0].hunks[0].importance = "low";}, w => {w.sections.push(structuredClone(w.sections[0]));}]) {
    const w = walkthrough(); mutate(w); assert.throws(() => validateWalkthrough(w, diff));
  }
});

test("deleted files are validated against available old-side lines", () => {
  const removed = `diff --git a/a.js b/a.js\ndeleted file mode 100644\n--- a/a.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-const value = 1;\n-export { value };\n`;
  assert.equal(validateWalkthrough(walkthrough(), removed).file_map.length, 1);
});

test("patch cannot invent update targets or collide section IDs", () => {
  const patch = { updated_sections: [], added_sections: [], removed_section_ids: [], file_map_changes: {added:[],removed:[],updated:[]}, architecture_diagram:null,title:null,subtitle:null,overview:null,review_tips:[] };
  validatePatch(patch, walkthrough());
  patch.added_sections = [walkthrough().sections[0]];
  assert.throws(() => validatePatch(patch, walkthrough()), /Invalid added section/);
  patch.added_sections = []; patch.updated_sections = [{id:"invented",section:walkthrough().sections[0]}];
  assert.throws(() => validatePatch(patch, walkthrough()), /Invalid updated section/);
});
