export function walkthroughIdentity(json) {
  const meta = json?.meta;
  if (!meta) return null;
  if (meta.generationId) return meta.generationId;
  return meta.generatedAt ? `${meta.generatedAt}:${meta.headSha || ''}` : null;
}

export function sameWalkthrough(left, right) {
  const identity = walkthroughIdentity(left);
  return !!identity && identity === walkthroughIdentity(right);
}

export function startWalkthroughPolling({ url, fetchData = fetch, onInitial, onTips, onError, onChanged,
  getCurrent, schedule = setTimeout, unschedule = clearTimeout }) {
  let stopped = false;
  let timer;
  let loaded = false;
  let failures = 0;
  const abort = new AbortController();
  const again = (delay) => { if (!stopped) timer = schedule(load, delay); };

  async function load() {
    try {
      const response = await fetchData(url + (loaded ? `?t=${Date.now()}` : ''), { signal: abort.signal, cache: 'no-store' });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.kind = response.status === 404 ? 'missing' : 'http';
        error.retry = response.status !== 404;
        throw error;
      }
      if (!(response.headers.get('content-type') || '').includes('json')) {
        const error = new Error('Expected walkthrough JSON');
        error.kind = 'stale-dev-server';
        throw error;
      }
      let json;
      try { json = await response.json(); }
      catch (error) { error.kind = 'parse'; throw error; }
      if (stopped) return;
      if (!json?.walkthrough || !Array.isArray(json.walkthrough.sections) || typeof json.diff !== 'string') {
        const error = new Error('Invalid walkthrough data');
        error.kind = 'parse';
        throw error;
      }
      failures = 0;
      if (!loaded) { onInitial(json); loaded = true; }
      else if (sameWalkthrough(getCurrent(), json)) { onTips(json.walkthrough.review_tips || []); }
      else { onChanged?.(); return; }
      if ((json.walkthrough.review_tips || []).some(tip => typeof tip === 'object' && tip.pending)) again(4000);
    } catch (error) {
      if (stopped) return;
      if (!loaded) onError?.({ kind: error.kind || 'network', message: error.message });
      if (error.retry !== false) again(Math.min(30_000, 4000 * 2 ** Math.min(failures++, 3)));
    }
  }
  load();
  return () => { stopped = true; abort.abort(); if (timer !== undefined) unschedule(timer); };
}
