import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { execSync, spawn } from 'child_process';
import { readFileSync } from 'fs';

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
          try {
            const { method, endpoint, data } = JSON.parse(body);
            const httpMethod = (method || 'GET').toUpperCase();

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

            const result = execSync(cmd, {
              encoding: 'utf-8',
              maxBuffer: 10 * 1024 * 1024,
            });

            res.setHeader('Content-Type', 'application/json');
            res.end(result);
          } catch (err) {
            res.statusCode = err.status || 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: err.message,
              stderr: err.stderr?.toString() || '',
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

// Middleware to handle AI chat via Claude Code CLI
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
        req.on('end', () => {
          try {
            const {
              message, history, sectionId, sectionTitle,
              sectionNarrative, sectionFiles, prTitle, prUrl, prOverview,
              projectPath,
            } = JSON.parse(body);

            // Build conversation context for Claude
            const historyText = (history || [])
              .map(m => `<${m.role}>\n${m.content}\n</${m.role}>`)
              .join('\n\n');

            const systemPrompt = [
              'You are an AI code review assistant embedded in a PR walkthrough tool.',
              'You help reviewers understand code changes, design decisions, and implications.',
              '',
              prTitle ? `## PR: ${prTitle}` : '',
              prUrl ? `URL: ${prUrl}` : '',
              prOverview ? `## Overview\n${prOverview}` : '',
              sectionTitle ? `## Current Section: ${sectionTitle}` : '',
              sectionNarrative ? `## Section Narrative\n${sectionNarrative}` : '',
              sectionFiles?.length ? `## Files in this section\n${sectionFiles.join('\n')}` : '',
              historyText ? `## Conversation history\n${historyText}` : '',
              '',
              '## Instructions',
              '- Answer questions about the code changes in this PR section',
              '- When referencing code, cite specific files and line numbers',
              '- Use tools to explore the codebase, read source files, and check git history',
              '- Keep responses concise and actionable — this is a review context',
              '- Format with markdown: code blocks, bold, lists',
            ].filter(Boolean).join('\n');

            // Determine working directory
            let cwd = process.cwd();
            if (projectPath) cwd = projectPath;

            // Stream response via Claude CLI
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Cache-Control', 'no-cache');

            const proc = spawn('claude', [
              '-p', message,
              '-s', systemPrompt,
              '--output-format', 'stream-json',
              '--allowedTools', 'Read,Grep,Glob,Bash(git log:git diff:git show:git blame:ls)',
            ], {
              cwd,
              env: { ...process.env, TERM: 'dumb' },
              stdio: ['pipe', 'pipe', 'pipe'],
            });

            let fullContent = '';
            let buffer = '';

            proc.stdout.on('data', (chunk) => {
              buffer += chunk.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop();

              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const event = JSON.parse(line);
                  // Extract text from assistant messages
                  if (event.type === 'assistant' && event.message?.content) {
                    let text = '';
                    for (const block of event.message.content) {
                      if (block.type === 'text') text += block.text;
                    }
                    if (text && text.length > fullContent.length) {
                      const newChunk = text.slice(fullContent.length);
                      fullContent = text;
                      res.write(newChunk);
                    }
                  }
                  // Handle result type (final output)
                  if (event.type === 'result' && event.result) {
                    const text = typeof event.result === 'string' ? event.result : '';
                    if (text && text.length > fullContent.length) {
                      const newChunk = text.slice(fullContent.length);
                      fullContent = text;
                      res.write(newChunk);
                    }
                  }
                } catch {}
              }
            });

            proc.stderr.on('data', () => {}); // suppress

            proc.on('close', () => {
              res.end();
            });

            proc.on('error', (err) => {
              if (!res.headersSent) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err.message }));
              } else {
                res.end();
              }
            });

            proc.stdin.end();

            // Clean up if client disconnects
            req.on('close', () => {
              try { proc.kill(); } catch {}
            });
          } catch (err) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message }));
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
