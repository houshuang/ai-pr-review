import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerminalProgress, parseProgress, reviewHeading } from "../src/terminal-progress.js";

function fixture(live, columns = 80) {
  let text = "",
    time = 0;
  const display = createTerminalProgress({
    live,
    color: false,
    output: { columns, write: (chunk) => (text += chunk) },
    now: () => time,
  });
  return { display, read: () => text, tick: (ms) => (time += ms) };
}
test("parallel progress retains distinct rows and updates them in place with elapsed/activity evidence", () => {
  const f = fixture(true);
  try {
    f.display.line("Implementation research started.");
    f.display.line("Invariant and test research started.");
    f.display.line(
      "Implementation research still running (2m 30s). 20/20 source commands finished. Last Codex activity 11s ago.",
    );
    assert.match(f.read(), /Implementation\s+2:30\s+20 source commands/);
    assert.match(f.read(), /Tests & invariants/);
    assert.match(f.read(), /\x1b\[2A\x1b\[0J/);
    assert.doesNotMatch(f.read(), /20\/20|still running/);
    f.display.line("Implementation research completed (2m 40s).");
    assert.match(f.read(), /✓ Implementation\s+2:40\s+done/);
  } finally {
    f.display.close();
  }
});
test("plain output stays streaming and contains no renderer ANSI controls", () => {
  const f = fixture(false);
  const line = "Repository research still running (1m 0s). 10/10 source commands finished.";
  f.display.line(line);
  f.display.line("Slug: owner-repo-1");
  f.display.close();
  assert.equal(f.read(), line + "\nSlug: owner-repo-1\n");
});
test("errors remain visible and unfinished stages stop on renderer closure", () => {
  const f = fixture(true);
  f.display.line("Writing walkthrough started.");
  f.tick(30000);
  f.display.line("Failed: invalid source reference");
  f.display.close();
  assert.match(f.read(), /Failed: invalid source reference/);
  assert.match(f.read(), /– Write walkthrough\s+0:30\s+stopped/);
  assert.deepEqual(parseProgress("Writing walkthrough failed (1m 2s): API unavailable"), {
    label: "Writing walkthrough",
    status: "failed",
    elapsedMs: 62000,
    commands: null,
    idleMs: null,
    error: "API unavailable",
  });
});
test("live rows fit narrow terminals and cannot introduce escape controls from input", () => {
  const f = fixture(true, 40);
  f.display.line("Repairing walkthrough failed (0m 2s): error\x1b[2J from tool");
  f.display.close();
  const clean = f.read().replace(/\x1b\[\d*A\x1b\[0J/g, "");
  assert(!clean.includes("\x1b"));
  assert(clean.split("\n").every((line) => [...line].length <= 39));
});
test("headers identify GitHub reviews and unrelated messages are not swallowed as progress", () => {
  assert.equal(
    reviewHeading("https://github.com/tanainc/polaris/pull/10251"),
    "Review  tanainc/polaris #10251",
  );
  assert.equal(reviewHeading("--local"), "Code review");
  assert.equal(parseProgress("Walkthrough data written to file"), null);
  assert.equal(parseProgress("Some file says Implementation research started."), null);
});
