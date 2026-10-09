import { test } from "node:test";
import assert from "node:assert/strict";
import { linkFileRefs, md } from "../src/utils.js";

test("citations render compact accessible links with complete paths, ranges and revision identity", () => {
  const html = linkFileRefs(
    md(
      "Inspect `tools/llm-testing/__tests__/meetingImportOwnership.manual.test.ts:15`, `base packages/ai-streaming/src/proposals/proposalHelpers.ts:1841-1850` and base `packages/client/file.ts:35`.",
    ),
  );
  assert.match(html, /meetingImportOwnership.manual.test.ts:15<\/span>/);
  assert.match(
    html,
    /data-file-ref="tools\/llm-testing\/__tests__\/meetingImportOwnership.manual.test.ts"/,
  );
  assert.match(html, /data-end-line="1850" data-revision="base"/);
  assert.match(html, /data-line="35" data-end-line="35" data-revision="base"/);
  assert.match(html, /aria-label="Preview base source/);
  assert.equal((html.match(/class="file-ref-link"/g) || []).length, 3);
});

test("link rendering preserves code blocks, existing links and attributes and is idempotent", () => {
  const html =
    '<pre><code>src/file.ts:1</code></pre><a href="src/other.ts:3">src/other.ts:3</a><span title="src/title.ts:2">src/visible.ts:4</span>';
  const linked = linkFileRefs(html);
  assert.match(linked, /<pre><code>src\/file.ts:1<\/code><\/pre>/);
  assert.match(linked, /<a href="src\/other.ts:3">src\/other.ts:3<\/a>/);
  assert.match(linked, /title="src\/title.ts:2"/);
  assert.equal((linked.match(/class="file-ref-link"/g) || []).length, 1);
  assert.equal(linkFileRefs(linked), linked);
});

test("invalid and external paths cannot turn into misleading repository citations", () => {
  const text = "https://example.com:80 /private/file.ts:1 ../secret.ts:1 file.ts:0 file.ts:20-10";
  assert.equal(linkFileRefs(text), text);
});
