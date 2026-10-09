import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOrRepairWalkthrough } from "../src/walkthrough-repair.js";

const diff =
  "diff --git a/value.js b/value.js\n--- a/value.js\n+++ b/value.js\n@@ -1 +1 @@\n-old\n+new\n";
const walkthrough = (line) => ({
  title: "Value",
  subtitle: "",
  overview: "A worked example",
  architecture_diagram: "",
  sections: [
    {
      id: "value",
      title: "Replace value",
      narrative: "Preserve the contract",
      diagram: null,
      hunks: [
        {
          file: "value.js",
          startLine: line,
          endLine: line,
          annotation: "Replaces old",
          importance: "important",
        },
      ],
      callouts: [],
    },
  ],
  file_map: [],
  review_tips: [],
});

test("valid generation avoids repair; invalid references get one evidence-grounded repair", async () => {
  let calls = 0;
  const runner = async (options) => {
    calls++;
    assert.equal(options.task, "repair");
    assert.match(options.userPrompt, /"path":"value.js"/);
    assert.match(options.userPrompt, /"start":1,"end":1/);
    assert.match(options.systemPrompt, /untrusted evidence/);
    return JSON.stringify(walkthrough(1));
  };
  await validateOrRepairWalkthrough(walkthrough(1), diff, { runner });
  assert.equal(calls, 0);
  const repaired = await validateOrRepairWalkthrough(walkthrough(100), diff, { runner });
  assert.equal(calls, 1);
  assert.equal(repaired.sections[0].hunks[0].startLine, 1);
  assert.equal(repaired.sections[0].narrative, "Preserve the contract");
});

test("an invalid repair still fails instead of publishing or retrying without a bound", async () => {
  let calls = 0;
  await assert.rejects(
    validateOrRepairWalkthrough(walkthrough(100), diff, {
      runner: async () => {
        calls++;
        return JSON.stringify(walkthrough(100));
      },
    }),
    /Hunk range outside diff/,
  );
  assert.equal(calls, 1);
});
