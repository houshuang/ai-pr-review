import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { getTaskConfig } from './src/models.js';
import { resolveAIProvider, runCodex } from './src/ai-provider.js';
import { createGithubHandler, createExportHandler, validSlug, sendError } from './src/server-http.js';
import { createChatHandler } from './src/server-chat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logsDir = resolve(__dirname, 'logs');
if (!existsSync(logsDir)) mkdirSync(logsDir);
const apiLogFile = resolve(logsDir, 'api.log');

function apiLog(level, method, endpoint, detail) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${method} ${endpoint}${detail ? ' — ' + detail : ''}\n`;
  appendFileSync(apiLogFile, line);
}

function endpointPlugin(name, path, handler) {
  return { name, configureServer(server) { server.middlewares.use(path, handler); } };
}

// Walkthroughs generated after Vite starts must bypass its cached public listing.
function walkthroughsEndpoint() {
  return {
    name: 'walkthroughs-endpoint',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];
        if (!url) return next();
        let path;
        if (url === '/walkthrough-data.json') path = resolve(__dirname, 'public/walkthrough-data.json');
        else if (url.startsWith('/walkthroughs/') && url.endsWith('.json')) {
          const slug = url.slice('/walkthroughs/'.length, -'.json'.length);
          if (!validSlug(slug)) { res.statusCode = 400; res.end('Bad request'); return; }
          path = resolve(__dirname, 'public/walkthroughs', `${slug}.json`);
        } else return next();
        try {
          const content = await readFile(path, 'utf8');
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(content);
        } catch (error) {
          if (error.code === 'ENOENT') { error.status = 404; error.message = 'Not found'; }
          sendError(res, error);
        }
      });
    },
  };
}

function loadChatApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const envPath = resolve(__dirname, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^ANTHROPIC_(?:API_)?KEY=(.+)$/);
      if (match) return match[1].trim();
    }
  }
  return null;
}

export default defineConfig({
  root: '.',
  build: { outDir: 'dist' },
  plugins: [
    preact(), walkthroughsEndpoint(),
    endpointPlugin('gh-api-proxy', '/api/gh', createGithubHandler({ log: apiLog })),
    endpointPlugin('export-endpoint', '/api/export', createExportHandler({ root: __dirname })),
    endpointPlugin('chat-middleware', '/api/chat', createChatHandler({
      root: __dirname, runCodex, resolveAIProvider, taskConfig: getTaskConfig,
      anthropicClient: () => {
        const apiKey = loadChatApiKey();
        if (!apiKey) throw new Error('No ANTHROPIC_API_KEY configured');
        return new Anthropic({ apiKey, timeout: 5 * 60_000 });
      },
    })),
  ],
});
