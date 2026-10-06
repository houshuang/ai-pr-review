import { test } from "node:test";
import assert from "node:assert/strict";
import { blockLayout } from "../src/diff.js";

const block = (dels, adds, context = 3) => ({
  lines: [
    ...Array(context).fill({ type: "context" }),
    ...Array(dels).fill({ type: "delete" }),
    ...Array(adds).fill({ type: "insert" }),
  ],
});

test("unified mode stays unified", () => {
  assert.equal(blockLayout(block(5, 5), "unified"), "unified");
});

test("balanced edits keep side-by-side", () => {
  assert.equal(blockLayout(block(5, 5), "side-by-side"), "side-by-side");
  assert.equal(blockLayout(block(4, 10), "side-by-side"), "side-by-side");
});

test("one-sided blocks fall back to unified", () => {
  assert.equal(blockLayout(block(0, 12), "side-by-side"), "unified");
  assert.equal(blockLayout(block(8, 0), "side-by-side"), "unified");
  assert.equal(blockLayout(block(0, 0), "side-by-side"), "unified");
});

test("lopsided edits fall back to unified", () => {
  assert.equal(blockLayout(block(2, 29), "side-by-side"), "unified");
  assert.equal(blockLayout(block(10, 3), "side-by-side"), "unified");
});
