import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTENT_SECURITY_POLICY } from './netlify/functions/_lib/csp.js';

/**
 * Local dev server. Serves the static site and routes /api/<name> to the
 * matching Netlify function handler in netlify/functions/<name>.ts — mirroring
 * the production redirect (/api/* → /.netlify/functions/:splat) so the same
 * front-end code works locally and on Netlify. Not used in production.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.join(__dirname, 'netlify', 'functions');
const PORT = Number(process.env.PORT || 8787);

const app = express();
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  const p = req.path;
  if (p === '/app' || p === '/app/' || p.startsWith('/app/')) {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  if (p === '/app/reset.html') res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const NAME_RE = /^[a-z0-9-]+$/;

app.all('/api/:name', async (req, res) => {
  const name = req.params.name;
  if (!NAME_RE.test(name)) return res.status(404).json({ error: 'Unknown endpoint' });
  try {
    const mod = await import(pathToFileURL(path.join(FUNCTIONS_DIR, `${name}.ts`)).href);
    if (typeof mod.handler !== 'function') return res.status(404).json({ error: 'Unknown endpoint' });
    const event = {
      httpMethod: req.method,
      headers: req.headers as Record<string, string | undefined>,
      queryStringParameters: req.query as Record<string, string | undefined>,
      body: req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : null,
    };
    const result = await mod.handler(event);
    res.status(result.statusCode || 200);
    for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v as string);
    res.send(result.body);
  } catch (err: any) {
    console.error(`[api/${name}]`, err);
    res.status(500).json({ error: 'Function error', detail: err?.message });
  }
});

// Static site (index.html, /app, blog, etc.)
app.use(express.static(__dirname, { extensions: ['html'] }));

app.listen(PORT, () => console.log(`aeconnect.io dev server → http://localhost:${PORT}`));
