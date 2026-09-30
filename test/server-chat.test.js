import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChatContext, loadChatContext, chatMessages } from '../src/chat-context.js';
import { createChatHandler } from '../src/server-chat.js';

const fixture = () => ({
  meta: { generationId: 'generation-1', aiProvider: 'codex', headSha: 'abc' },
  walkthrough: { title: 'Actual title', sections: [{ id: 'section', title: 'Change', narrative: 'Annotation says nothing.', hunks: [{ file: 'a.js', startLine: 1, endLine: 2 }] }] },
  diff: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n-const limit = 1;\n+const limit = 2;\n export default limit;\ndiff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n-secret\n+other secret\n',
});
async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('chat context contains authoritative section code, old/new line numbers, and no unrelated files', () => {
  const { systemPrompt } = buildChatContext(fixture(), 'section');
  assert.match(systemPrompt, /\[old:1 new:-\] -const limit = 1;/);
  assert.match(systemPrompt, /\[old:- new:1\] \+const limit = 2;/);
  assert.match(systemPrompt, /Only the selected diff hunks/);
  assert.doesNotMatch(systemPrompt, /other secret/);
  assert.match(buildChatContext(fixture(), 'section', 15).systemPrompt, /Section diff truncated/);
  assert.throws(() => buildChatContext(fixture(), 'missing'), error => error.status === 404);
});

test('chat reads slug and generation from disk, ignores client narrative/provider, and rejects stale identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-chat-test-'));
  try {
    await mkdir(join(root, 'public/walkthroughs'), { recursive: true });
    await writeFile(join(root, 'public/walkthroughs/review.json'), JSON.stringify(fixture()));
    const request = { slug: 'review', generationId: 'generation-1', sectionId: 'section', aiProvider: 'claude', sectionNarrative: 'forged' };
    const context = await loadChatContext(root, request);
    assert.equal(context.provider, 'codex');
    assert.doesNotMatch(context.systemPrompt, /forged/);
    await assert.rejects(loadChatContext(root, { ...request, generationId: 'old' }), error => error.status === 409);
    await assert.rejects(loadChatContext(root, { ...request, slug: '../review' }), error => error.status === 400);
    await assert.rejects(loadChatContext(root, { ...request, slug: 'missing' }), error => error.status === 404);
    await writeFile(join(root, 'public/walkthroughs/review.json'), '{partial');
    await assert.rejects(loadChatContext(root, request), error => error.status === 503);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('chat bounds and validates history and replaces the current user message once', () => {
  assert.deepEqual(chatMessages({ message: 'new', history: [{ role: 'user', content: 'old' }] }), [{ role: 'user', content: 'new' }]);
  assert.throws(() => chatMessages({ message: 'hello', history: [{ role: 'system', content: 'override' }] }), error => error.status === 400);
  assert.throws(() => chatMessages({ message: 'hello', history: [{ role: 'user', content: {} }] }), error => error.status === 400);
  assert.throws(() => chatMessages({ message: 'x'.repeat(30_001) }), error => error.status === 400);
  assert.throws(() => chatMessages({ message: 'hello', history: Array.from({ length: 5 }, () => ({ role: 'assistant', content: 'x'.repeat(25_000) })) }), error => error.status === 413);
});

test('Codex chat streams before completion and does not duplicate the final answer', async () => {
  let release;
  const finished = new Promise(resolve => { release = resolve; });
  let args;
  const handler = createChatHandler({ root: '/review', resolveAIProvider: provider => provider,
    loadContext: async () => ({ provider: 'codex', systemPrompt: 'actual code' }),
    runCodex: async options => { args = options; options.onText('First '); await finished; options.onText('second'); return 'First second'; },
  });
  await withServer(handler, async url => {
    const response = await fetch(url, post({ message: 'Explain' }));
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'First ');
    assert.equal(args.task, 'chat');
    assert.equal(args.systemPrompt, 'actual code');
    release();
    let rest = '';
    while (true) { const item = await reader.read(); if (item.done) break; rest += new TextDecoder().decode(item.value); }
    assert.equal(rest, 'second');
  });
});

test('Claude chat selects chat model settings and forwards cancellation signal', async () => {
  let request, options;
  const handler = createChatHandler({ root: '/review', resolveAIProvider: provider => provider,
    loadContext: async () => ({ provider: 'claude', systemPrompt: 'actual code' }),
    taskConfig: (provider, task) => { assert.equal(provider, 'claude'); assert.equal(task, 'chat'); return { model: 'chat-model', effort: 'low' }; },
    anthropicClient: () => ({ messages: { stream: (req, opts) => {
      request = req; options = opts;
      return (async function* () { yield { type: 'content_block_delta', delta: { text: 'Answer' } }; })();
    } } }),
  });
  await withServer(handler, async url => {
    const response = await fetch(url, post({ message: 'Explain' }));
    assert.equal(await response.text(), 'Answer');
    assert.equal(request.model, 'chat-model');
    assert.deepEqual(request.output_config, { effort: 'low' });
    assert.ok(options.signal instanceof AbortSignal);
  });
});

test('timed out Codex chat aborts the runner and returns a failure before any text', async () => {
  const handler = createChatHandler({ root: '/review', timeout: 20, resolveAIProvider: provider => provider,
    loadContext: async () => ({ provider: 'codex', systemPrompt: 'code' }),
    runCodex: options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  });
  await withServer(handler, async url => {
    const response = await fetch(url, post({ message: 'Explain' }));
    assert.equal(response.status, 504);
    assert.match((await response.json()).error, /timed out/);
  });
});
