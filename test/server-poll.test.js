import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWalkthroughPolling, walkthroughIdentity, sameWalkthrough } from '../src/walkthrough-poll.js';

const fixture = (identity = 'one', pending = true) => ({ meta: { generationId: identity }, diff: '', walkthrough: { sections: [], review_tips: [{ pending }] } });
const response = data => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => data });
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(fetchData) {
  const timers = [];
  const errors = [];
  const updates = [];
  let current, changed = false;
  const stop = startWalkthroughPolling({ url: '/walkthrough.json', fetchData,
    schedule: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, unschedule: () => {},
    onInitial: json => { current = json; }, getCurrent: () => current,
    onTips: tips => { updates.push(tips); }, onError: error => errors.push(error), onChanged: () => { changed = true; },
  });
  return { timers, errors, updates, stop, get current() { return current; }, get changed() { return changed; } };
}

test('polling retries fetch and partial-JSON failures, then accepts same-generation tips', async () => {
  const values = [response(fixture()), new Error('network'), { ...response(null), json: async () => { throw new SyntaxError('partial'); } }, response(fixture('one', false))];
  const h = harness(async () => { const value = values.shift(); if (value instanceof Error) throw value; return value; });
  await flush();
  assert.equal(h.current.meta.generationId, 'one');
  await h.timers.shift().callback();
  assert.equal(h.timers[0].delay, 4000);
  await h.timers.shift().callback();
  assert.equal(h.timers[0].delay, 8000);
  await h.timers.shift().callback();
  assert.deepEqual(h.updates, [[{ pending: false }]]);
  assert.equal(h.timers.length, 0);
  h.stop();
});

test('polling never merges another generation and offers reload', async () => {
  let call = 0;
  const h = harness(async () => response(fixture(++call === 1 ? 'one' : 'two')));
  await flush();
  await h.timers.shift().callback();
  assert.equal(h.changed, true);
  assert.deepEqual(h.updates, []);
  assert.equal(h.timers.length, 0);
  h.stop();
});

test('initial transient failure retries; missing walkthrough stops; cancellation ignores in-flight response', async () => {
  let call = 0;
  const h = harness(async () => { if (++call === 1) throw new Error('network'); return response(fixture('one', false)); });
  await flush();
  assert.equal(h.errors[0].kind, 'network');
  await h.timers.shift().callback();
  assert.ok(h.current);
  h.stop();
  const missing = harness(async () => ({ ok: false, status: 404 }));
  await flush();
  assert.equal(missing.errors[0].kind, 'missing');
  assert.equal(missing.timers.length, 0);
  missing.stop();
  let release;
  const cancelled = harness(() => new Promise(resolve => { release = resolve; }));
  cancelled.stop();
  release(response(fixture()));
  await flush();
  assert.equal(cancelled.current, undefined);
  assert.equal(cancelled.timers.length, 0);
});

test('legacy generation identity includes timestamp and SHA; unidentified generations never match', () => {
  const older = { meta: { generatedAt: 'time', headSha: 'sha' } };
  assert.equal(walkthroughIdentity(older), 'time:sha');
  assert.equal(sameWalkthrough(older, { meta: { generatedAt: 'other', headSha: 'sha' } }), false);
  assert.equal(sameWalkthrough({}, {}), false);
});
