import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { repositoryContext } from "../src/repository-explanation.js";
import { runCodeTool, withCodeTools } from "../src/walkthrough-tools.js";
import { repositoryFixture } from "./repository-explanation.test.js";

test("code tools read and search unchanged files at the recorded revisions, not the dirty checkout", async (t) => {
  const { root, review } = repositoryFixture(t);
  const context = await repositoryContext(review.meta, review.diff, join(root, "cache"));
  t.after(() => context.cleanup());
  assert.match(await runCodeTool(context, "read_source", { path: "caller.js", line: 2 }), /2: export const render/);
  assert.match(await runCodeTool(context, "read_source", { path: "resolver.js", revision: "base" }), /Speaker 1/);
  assert.match(await runCodeTool(context, "search_code", { pattern: "label\\(" }), /^caller\.js:2:/);
  assert.equal(await runCodeTool(context, "search_code", { pattern: "dirty caller" }), "No matches.");
  await assert.rejects(runCodeTool(context, "search_code", { pattern: "x", path: "../" }), /Invalid search path/);
  await assert.rejects(runCodeTool(context, "read_source", { path: "../caller.js" }), /Invalid source path/);
});

test("the tool loop answers lookups, reports tool errors to the model, and forces an answer after the round cap", async (t) => {
  const { root, review } = repositoryFixture(t);
  const context = await repositoryContext(review.meta, review.diff, join(root, "cache"));
  t.after(() => context.cleanup());
  const requests = [];
  const send = async (params) => {
    requests.push(structuredClone(params));
    if (params.tool_choice?.type === "none") return { stop_reason: "end_turn", content: [{ type: "text", text: '{"sections":[]}' }], usage: {} };
    return {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "check the caller" },
        { type: "tool_use", id: `read${requests.length}`, name: "read_source", input: { path: "caller.js", line: 1 } },
        { type: "tool_use", id: `bad${requests.length}`, name: "read_source", input: { path: "missing.js" } },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
    };
  };
  const { response, rounds, usage } = await withCodeTools(send, { model: "m", messages: [{ role: "user", content: "write it" }] }, context, { maxRounds: 2 });
  assert.equal(response.content[0].text, '{"sections":[]}');
  assert.equal(rounds, 2);
  assert.deepEqual(usage, { input: 20, output: 10, cacheRead: 200 });
  const last = requests.at(-1).messages;
  assert.equal(last[1].content[0].type, "thinking");
  const [ok, failed] = last[2].content;
  assert.match(ok.content, /render/);
  assert.equal(failed.is_error, true);
  const marked = last.flatMap((message, index) => message.content.filter((block) => block.cache_control).map(() => index));
  assert.deepEqual(marked, [0, 2, 4]);
});
