import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { execSync } from 'child_process';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logsDir = resolve(__dirname, 'logs');
if (!existsSync(logsDir)) mkdirSync(logsDir);
const apiLogFile = resolve(logsDir, 'api.log');

function apiLog(level, method, endpoint, detail) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${method} ${endpoint}${detail ? ' — ' + detail : ''}\n`;
  appendFileSync(apiLogFile, line);
}

// Middleware to proxy GitHub API calls through `gh` CLI
function ghApiProxy() {
  return {
    name: 'gh-api-proxy',
    configureServer(server) {
      // POST /api/gh — proxy arbitrary gh api calls
      server.middlewares.use('/api/gh', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'POST only' }));
          return;
        }

        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          let httpMethod = 'unknown';
          let endpoint = 'unknown';
          try {
            const parsed = JSON.parse(body);
            endpoint = parsed.endpoint;
            const data = parsed.data;
            httpMethod = (parsed.method || 'GET').toUpperCase();

            // For GET requests, append data fields as query parameters in the URL
            // For other methods, pass as -f body fields
            let apiEndpoint = endpoint;
            if (httpMethod === 'GET' && data && typeof data === 'object') {
              const params = new URLSearchParams();
              for (const [key, value] of Object.entries(data)) {
                params.append(key, String(value));
              }
              const sep = apiEndpoint.includes('?') ? '&' : '?';
              apiEndpoint += sep + params.toString();
            }

            const safeEndpoint = apiEndpoint.replace(/'/g, "'\\''");
            let cmd = `gh api '${safeEndpoint}' --method ${httpMethod}`;

            if (httpMethod !== 'GET' && data && typeof data === 'object') {
              for (const [key, value] of Object.entries(data)) {
                const escaped = String(value).replace(/'/g, "'\\''");
                cmd += ` -f ${key}='${escaped}'`;
              }
            }

            apiLog('INFO', httpMethod, endpoint, httpMethod !== 'GET' ? `keys: ${Object.keys(data || {}).join(', ')}` : null);

            const result = execSync(cmd, {
              encoding: 'utf-8',
              maxBuffer: 10 * 1024 * 1024,
            });

            res.setHeader('Content-Type', 'application/json');
            res.end(result);
          } catch (err) {
            const stderr = err.stderr?.toString() || '';
            apiLog('ERROR', httpMethod, endpoint, `${err.message}${stderr ? '\n  stderr: ' + stderr : ''}`);
            res.statusCode = err.status || 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: err.message,
              stderr,
            }));
          }
        });
      });
    },
  };
}

// Endpoint to export a static HTML walkthrough
function exportEndpoint() {
  return {
    name: 'export-endpoint',
    configureServer(server) {
      server.middlewares.use('/api/export', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'GET only' }));
          return;
        }

        try {
          const url = new URL(req.url, 'http://localhost');
          const slug = url.searchParams.get('slug') || 'walkthrough-data';
          const mode = url.searchParams.get('mode') || 'unified';
          const tmpFile = `/tmp/review-export-${slug}.html`;

          execSync(
            `node src/export-static.js ${JSON.stringify(slug)} --output ${JSON.stringify(tmpFile)} --mode ${JSON.stringify(mode)}`,
            { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
          );

          const html = readFileSync(tmpFile, 'utf-8');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${slug}.html"`);
          res.end(html);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message, stderr: err.stderr?.toString() || '' }));
        }
      });
    },
  };
}

// Load API key from env or .env file
function loadChatApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const __dir = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(__dir, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^ANTHROPIC_(?:API_)?KEY=(.+)$/);
      if (m) return m[1].trim();
    }
  }
  return null;
}

// Middleware to handle AI chat via Anthropic API (streaming)
function chatMiddleware() {
  return {
    name: 'chat-middleware',
    configureServer(server) {
      server.middlewares.use('/api/chat', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'POST only' }));
          return;
        }

        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const {
              message, history, sectionTitle,
              sectionNarrative, sectionHunks, sectionCallouts, sectionDiagram,
              prTitle, prUrl, prOverview,
            } = JSON.parse(body);

            const apiKey = loadChatApiKey();
            if (!apiKey) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'No ANTHROPIC_API_KEY configured' }));
              return;
            }

            // Build rich hunk context
            let hunksContext = '';
            if (sectionHunks?.length) {
              hunksContext = '\n## Code Changes in this Section\n' +
                sectionHunks.map(h =>
                  `**${h.file}** (lines ${h.lines}, ${h.importance})\n${h.annotation}`
                ).join('\n\n');
            }

            let calloutsContext = '';
            if (sectionCallouts?.length) {
              calloutsContext = '\n## Callouts\n' + sectionCallouts.join('\n');
            }

            const systemPrompt = [
              'You are an AI code review assistant embedded in a PR walkthrough tool.',
              'You help reviewers understand code changes, design decisions, and implications.',
              'You have the full context of the current section including narrative, code annotations, and callouts.',
              '',
              prTitle ? `## PR: ${prTitle}` : '',
              prUrl ? `URL: ${prUrl}` : '',
              prOverview ? `## Overview\n${prOverview}` : '',
              sectionTitle ? `## Current Section: ${sectionTitle}` : '',
              sectionNarrative ? `## Section Narrative\n${sectionNarrative}` : '',
              hunksContext,
              calloutsContext,
              sectionDiagram ? `## Section Diagram\n${sectionDiagram}` : '',
              '',
              '## Instructions',
              '- Answer questions about the code changes in this PR section',
              '- When referencing code, cite specific files and line numbers',
              '- If the user quotes code with >, focus your answer on that specific code',
              '- Keep responses concise and actionable — this is a review context',
              '- Format with markdown: code blocks, bold, lists, tables',
            ].filter(Boolean).join('\n');

            // Build messages from conversation history
            const messages = [];
            for (const m of (history || []).slice(-20)) {
              if (m.role === 'user' || m.role === 'assistant') {
                messages.push({ role: m.role, content: m.content });
              }
            }
            // Replace last user message (it's the current one) or add it
            if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
              messages[messages.length - 1].content = message;
            } else {
              messages.push({ role: 'user', content: message });
            }

            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');

            const client = new Anthropic({ apiKey });
            const stream = await client.messages.stream({
              model: 'claude-sonnet-4-6',
              max_tokens: 4096,
              system: systemPrompt,
              messages,
            });

            let aborted = false;
            res.on('close', () => { aborted = true; stream.abort(); });

            for await (const event of stream) {
              if (aborted) break;
              if (event.type === 'content_block_delta' && event.delta?.text) {
                res.write(event.delta.text);
              }
            }
            res.end();
          } catch (err) {
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message }));
            } else {
              res.end();
            }
          }
        });
      });
    },
  };
}

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
  plugins: [preact(), ghApiProxy(), exportEndpoint(), chatMiddleware()],
});
