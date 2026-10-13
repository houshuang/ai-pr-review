import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_REPAIR_ROUNDS, validateOrRepairWalkthrough } from "../src/walkthrough-repair.js";

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

test("hunks that run past a changed block are trimmed without a model call", async () => {
  const twoBlocks = "diff --git a/value.js b/value.js\n--- a/value.js\n+++ b/value.js\n@@ -1 +1 @@\n-old\n+new\n@@ -20 +20 @@\n-a\n+b\n";
  const overshoot = walkthrough(1);
  overshoot.sections[0].hunks[0].endLine = 3;
  overshoot.sections[0].hunks.push({ ...overshoot.sections[0].hunks[0], startLine: 18, endLine: 25 });
  const repaired = await validateOrRepairWalkthrough(overshoot, twoBlocks, {
    runner: async () => assert.fail("no repair call is needed"),
  });
  assert.deepEqual(repaired.sections[0].hunks.map((hunk) => [hunk.startLine, hunk.endLine]), [[1, 1], [20, 20]]);
});

test("an invalid repair still fails after the bounded rounds instead of publishing", async () => {
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
  assert.equal(calls, MAX_REPAIR_ROUNDS);
});

test("one repair request names every problem, with the file's changed ranges", async () => {
  const broken = walkthrough(100);
  broken.sections[0].hunks.push({ ...broken.sections[0].hunks[0], startLine: 200, endLine: 200 });
  broken.sections[0].hunks.push({ ...broken.sections[0].hunks[0], file: "missing.js" });
  let prompt;
  await validateOrRepairWalkthrough(broken, diff, {
    runner: async (options) => {
      prompt = options.userPrompt;
      return JSON.stringify(walkthrough(1));
    },
  });
  assert.match(prompt, /3 problems/);
  assert.match(prompt, /value\.js:100-100 \(changed ranges: 1-1\)/);
  assert.match(prompt, /value\.js:200-200/);
  assert.match(prompt, /Unknown hunk file in section value: missing\.js/);
});

test("citation problems are repaired, and any that survive lose their line link instead of failing", async () => {
  const cited = (text) => ({ ...walkthrough(1), overview: text });
  const checkCitations = async (value) =>
    value.overview.includes("value.js:99")
      ? [{ check: "citation", cited: "value.js:99", message: "overview: citation `value.js:99` is past the end of value.js" }]
      : [];
  let prompts = [];
  const repaired = await validateOrRepairWalkthrough(cited("See value.js:99."), diff, {
    checkCitations,
    runner: async (options) => {
      prompts.push(options.userPrompt);
      return JSON.stringify(cited("See value.js:1."));
    },
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /value\.js:99/);
  assert.equal(repaired.overview, "See value.js:1.");

  const kept = await validateOrRepairWalkthrough(cited("See value.js:99."), diff, {
    checkCitations,
    runner: async () => JSON.stringify(cited("See value.js:99.")),
  });
  assert.equal(kept.overview, "See value.js.");
});
