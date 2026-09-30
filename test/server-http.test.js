import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGithubHandler, createExportHandler, githubRequest, runCommand } from '../src/server-http.js';

async function withServer(handler, testBody) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await testBody(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('GitHub proxy preserves shell syntax as JSON text and sends typed comment lines', async () => {
  const calls = [];
  const command = async (...args) => { calls.push(args); return '{"id":1}'; };
  await withServer(createGithubHandler({ command }), async url => {
    const body = 'hello $(touch /tmp/injected) `printf foo` "quotes"\n@/etc/passwd';
    const response = await fetch(url, post({ method: 'POST', endpoint: 'repos/a/b/pulls/1/comments', data: {
      body, path: 'a.js', line: '2', side: 'RIGHT', commit_id: 'abc', start_line: '1', start_side: 'RIGHT',
    } }));
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0][1], ['api', 'repos/a/b/pulls/1/comments', '--method', 'POST', '--input', '-']);
    assert.deepEqual(JSON.parse(calls[0][2].input), { body, path: 'a.js', line: 2, side: 'RIGHT', commit_id: 'abc', start_line: 1, start_side: 'RIGHT' });
  });
});

test('GitHub proxy rejects arbitrary methods, endpoints, fields and malformed bodies before subprocesses', async () => {
  let calls = 0;
  await withServer(createGithubHandler({ command: async () => { calls++; return '{}'; } }), async url => {
    for (const body of [
      { method: 'GET; echo bad', endpoint: 'repos/a/b/pulls/1' },
      { method: 'DELETE', endpoint: 'repos/a/b/pulls/1' },
      { method: 'POST', endpoint: 'repos/a/b/issues/1' },
      { method: 'GET', endpoint: '--hostname attacker' },
      { endpoint: 'repos/a/b/contents/../../secret', data: {} },
      { endpoint: 'repos/a/b/pulls/1?extra=true' },
      { endpoint: 'repos/a/b/pulls/1', data: { 'x; echo bad': 'a' } },
      { endpoint: 'repos/a/b/contents/a', data: { ref: { value: 'abc' } } },
      { endpoint: 'repos/a/b/pulls/1', data: [] },
      { method: 'POST', endpoint: 'repos/a/b/pulls/1/reviews', data: { event: 'DELETE' } },
    ]) assert.equal((await fetch(url, post(body))).status, 400, JSON.stringify(body));
    assert.equal((await fetch(url, { method: 'POST', body: '{bad' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', body: 'x'.repeat(300_000) })).status, 413);
    assert.equal((await fetch(url, { ...post({}), headers: { origin: 'https://attacker.example' } })).status, 403);
    assert.equal(calls, 0);
  });
});

test('GitHub allowlist retains every viewer read and review operation', () => {
  for (const endpoint of ['repos/a/b/pulls/1', 'repos/a/b/pulls/1/comments', 'repos/a/b/pulls/1/reviews', `repos/a/b/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`]) {
    assert.deepEqual(githubRequest({ endpoint }).args, ['api', endpoint, '--method', 'GET']);
  }
  const content = githubRequest({ endpoint: 'repos/a/b/contents/src/file name.js', data: { ref: 'abc/branch' } });
  assert.equal(content.args[1], 'repos/a/b/contents/src/file name.js?ref=abc%2Fbranch');
  assert.equal(githubRequest({ method: 'POST', endpoint: 'repos/a/b/pulls/1/reviews', data: { event: 'APPROVE', body: '' } }).input, '{"event":"APPROVE","body":""}');
});

test('export rejects command substitution and traversal, uses private temporary directories and cleans them', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'review-server-test-'));
  const paths = [];
  try {
    const command = async (file, args, options) => {
      assert.equal(file, process.execPath);
      assert.equal(args[0], '/review/src/export-static.js');
      assert.equal(options.cwd, '/review');
      assert.equal(options.timeout, 60_000);
      const output = args[args.indexOf('--output') + 1];
      paths.push(output);
      await writeFile(output, '<h1>review</h1>');
      return '';
    };
    await withServer(createExportHandler({ root: '/review', command, tempRoot: temporary }), async url => {
      for (const params of ['slug=$(echo bad)', 'slug=../bad', 'slug=a&mode=$(echo bad)', 'slug=a%0D%0AX-Test:yes']) {
        assert.equal((await fetch(url + '?' + params)).status, 400);
      }
      const results = await Promise.all([fetch(url + '?slug=a'), fetch(url + '?slug=a&mode=side-by-side')]);
      for (const result of results) { assert.equal(result.status, 200); assert.equal(await result.text(), '<h1>review</h1>'); }
    });
    assert.equal(new Set(paths).size, 2);
    assert.deepEqual(await readdir(temporary), []);
    await withServer(createExportHandler({ root: '/review', tempRoot: temporary, command: async () => { throw new Error('failed'); } }), async url => {
      assert.equal((await fetch(url)).status, 500);
    });
    assert.deepEqual(await readdir(temporary), []);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('subprocess runner uses literal arguments and terminates a hung child', async () => {
  assert.equal(await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo injected)']), '$(echo injected)');
  await assert.rejects(runCommand(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 50 }), error => error.killed === true);
});
