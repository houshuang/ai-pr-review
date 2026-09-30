import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function sendError(res, error) {
  if (res.headersSent) { res.destroy(error); return; }
  res.statusCode = error.status || 500;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: error.message }));
}

export function checkOrigin(req) {
  if (!req.headers.origin) return;
  let origin;
  try { origin = new URL(req.headers.origin); } catch { throw new HttpError(403, 'Invalid origin'); }
  if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) {
    throw new HttpError(403, 'Requests must come from this viewer');
  }
}

export async function readJsonBody(req, limit = 256 * 1024) {
  checkOrigin(req);
  const body = await new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', aborted);
    };
    const failed = error => { cleanup(); req.resume(); reject(error); };
    const aborted = () => failed(new HttpError(400, 'Request was aborted'));
    const data = chunk => {
      size += Buffer.byteLength(chunk);
      if (size > limit) { failed(new HttpError(413, 'Request body is too large')); return; }
      chunks.push(Buffer.from(chunk));
    };
    const end = () => { cleanup(); resolveBody(Buffer.concat(chunks).toString('utf8')); };
    const timer = setTimeout(() => failed(new HttpError(408, 'Request body timed out')), 15_000);
    req.on('data', data); req.on('end', end); req.on('error', failed); req.on('aborted', aborted);
  });
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, 'Expected a JSON object'); }
}

export function runCommand(file, args, { cwd, input, timeout = 30_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(file, args, { cwd, timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolvePromise(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

export function githubRequest({ method = 'GET', endpoint, data = {} }) {
  if (!['GET', 'POST'].includes(method)) throw new HttpError(400, 'Unsupported GitHub method');
  if (typeof endpoint !== 'string' || endpoint.length > 4096 || /[\x00-\x1f?#\\]/.test(endpoint)) {
    throw new HttpError(400, 'Invalid GitHub endpoint');
  }
  const match = endpoint.match(/^repos\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/(.+)$/);
  if (!match || match[2] === '.' || match[2] === '..') throw new HttpError(400, 'Unsupported GitHub endpoint');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Invalid GitHub fields');
  const route = match[3];
  let allowed = [];
  if (method === 'GET') {
    if (/^pulls\/[1-9]\d*(?:\/(?:comments|reviews))?$/.test(route) || /^compare\/[a-f0-9]{7,40}\.\.\.[a-f0-9]{7,40}$/i.test(route)) {
      allowed = [];
    } else if (route.startsWith('contents/') && route.slice(9).split('/').every(part => part && !['.', '..'].includes(part))) {
      allowed = ['ref'];
    } else { throw new HttpError(400, 'Unsupported GitHub endpoint'); }
  } else if (/^pulls\/[1-9]\d*\/comments$/.test(route)) {
    allowed = ['body', 'path', 'line', 'side', 'commit_id', 'start_line', 'start_side'];
    for (const key of ['body', 'path', 'line', 'side', 'commit_id']) {
      if (!(key in data)) throw new HttpError(400, `Missing ${key}`);
    }
  } else if (/^pulls\/[1-9]\d*\/reviews$/.test(route)) {
    allowed = ['body', 'event'];
    if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(data.event)) throw new HttpError(400, 'Invalid review event');
  } else { throw new HttpError(400, 'Unsupported GitHub endpoint'); }
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    if (!allowed.includes(key) || !['string', 'number'].includes(typeof value)) throw new HttpError(400, `Unsupported GitHub field: ${key}`);
    if (['line', 'start_line'].includes(key)) {
      if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new HttpError(400, 'Invalid line number');
      fields[key] = Number(value);
    } else {
      if (['side', 'start_side'].includes(key) && !['LEFT', 'RIGHT'].includes(value)) throw new HttpError(400, 'Invalid comment side');
      fields[key] = value;
    }
  }
  const args = ['api', endpoint, '--method', method];
  let input;
  if (method === 'GET' && Object.keys(fields).length) args[1] += '?' + new URLSearchParams(fields);
  if (method === 'POST') { args.push('--input', '-'); input = JSON.stringify(fields); }
  return { args, input };
}

export function createGithubHandler({ command = runCommand, log = () => {} } = {}) {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'POST only');
      const body = await readJsonBody(req);
      const { args, input } = githubRequest(body);
      log('INFO', body.method || 'GET', body.endpoint);
      const output = await command('gh', args, { input });
      res.setHeader('Content-Type', 'application/json');
      res.end(output);
    } catch (err) {
      if (err.stderr?.includes('HTTP 422')) err.status = 422;
      if (err.stderr?.includes('HTTP 404')) err.status = 404;
      log('ERROR', req.method, '/api/gh', err.message);
      sendError(res, err);
    }
  };
}

export function validSlug(slug) {
  return typeof slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(slug) && !slug.includes('..');
}

export function createExportHandler({ root, command = runCommand, tempRoot = tmpdir() }) {
  return async (req, res) => {
    let temporary, html, slug, error;
    try {
      checkOrigin(req);
      if (req.method !== 'GET') throw new HttpError(405, 'GET only');
      const url = new URL(req.url, 'http://localhost');
      slug = url.searchParams.get('slug') || 'walkthrough-data';
      const mode = url.searchParams.get('mode') || 'unified';
      if (!validSlug(slug) || !['unified', 'side-by-side'].includes(mode)) throw new HttpError(400, 'Invalid export slug or mode');
      temporary = await mkdtemp(join(tempRoot, 'review-export-'));
      const output = join(temporary, 'review.html');
      await command(process.execPath, [resolve(root, 'src/export-static.js'), slug, '--output', output, '--mode', mode], { cwd: root, timeout: 60_000 });
      html = await readFile(output);
    } catch (err) { error = err; }
    try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    catch (err) { error = err; }
    if (error) { sendError(res, error); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.html"`);
    res.end(html);
  };
}
