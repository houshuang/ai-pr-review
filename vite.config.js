import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { execSync } from 'child_process';
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

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
  plugins: [preact(), ghApiProxy(), exportEndpoint()],
});
