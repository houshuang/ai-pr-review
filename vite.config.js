import { defineConfig } from 'vite';
import { execSync } from 'child_process';

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

            const safeEndpoint = endpoint.replace(/'/g, "'\\''");
            let cmd = `gh api '${safeEndpoint}' --method ${httpMethod}`;

            // Add request body fields
            if (data && typeof data === 'object') {
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

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
  plugins: [ghApiProxy()],
});
