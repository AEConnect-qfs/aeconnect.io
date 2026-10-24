import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Local dev server. Serves the static site and routes /api/<name> to the
 * matching Netlify function handler in netlify/functions/<name>.ts — mirroring
 * the production redirect (/api/* → /.netlify/functions/:splat) so the same
 * front-end code works locally and on Netlify. Not used in production.
 *
 * Security headers match netlify.toml except two production-only directives:
 * HSTS and CSP `upgrade-insecure-requests` (both break plain http://localhost).
 * Legacy 301s below must stay in sync with the "previously indexed" rules in
 * netlify.toml. Trailing-slash canonicals are the directory indexes themselves;
 * express.static 301s a non-slash directory request to the slash form.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.join(__dirname, 'netlify', 'functions');
const PORT = Number(process.env.PORT || 8787);

const LEGACY_REDIRECTS: Record<string, string> = {
  '/blog/meddra-coding-at-intake-ai-pharmacovigilance':
    '/blog/the-missing-layer-in-pharmacovigilance-ae-connect/',
  '/blog/meddra-coding-at-intake-ai-pharmacovigilance/':
    '/blog/the-missing-layer-in-pharmacovigilance-ae-connect/',
  '/adverse-event-intake-system': '/',
  '/adverse-event-intake-system/': '/',
  '/blog/safety-database-comparison-argus-veeva-reportum-ae-connect':
    '/blog/veeva-argus-overkill-early-phase-biotech/',
  '/blog/safety-database-comparison-argus-veeva-reportum-ae-connect/':
    '/blog/veeva-argus-overkill-early-phase-biotech/',
  '/blog/oracle-argus-alternative': '/blog/oracle-argus/',
  '/blog/oracle-argus-alternative/': '/blog/oracle-argus/',
  '/blog/arisglobal-lifesphere-alternative': '/blog/arisglobal-lifesphere/',
  '/blog/arisglobal-lifesphere-alternative/': '/blog/arisglobal-lifesphere/',
  '/blog/veeva-vault-safety-alternative': '/blog/veeva-vault-safety/',
  '/blog/veeva-vault-safety-alternative/': '/blog/veeva-vault-safety/',
  '/beta': '/trial/',
  '/beta/': '/trial/',
  '/about': '/',
  '/about/': '/',
};

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://cdn.jsdelivr.net",
  "manifest-src 'self'",
  "media-src 'self' blob:",
].join('; ');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false }));
// Netlify intercepts this form in production and redirects to the action URL.
// Locally, send the same redirect so the thanks page can be exercised.
app.post('/resources/ae-intake-checklist/thanks', (_req, res) => {
  res.redirect(303, '/resources/ae-intake-checklist/thanks/');
});
app.post('/resources/ae-intake-checklist/thanks/', (_req, res) => {
  res.redirect(303, '/resources/ae-intake-checklist/thanks/');
});

// Keep this list aligned with assets/work-email.js.
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com',
]);

function companyEmailOk(email: unknown) {
  const value = String(email ?? '').trim().toLowerCase();
  const domain = value.split('@')[1] || '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !PERSONAL_EMAIL_DOMAINS.has(domain);
}

function sandboxTrialPost(req: express.Request, res: express.Response) {
  const name = String(req.body?.name ?? '').trim();
  const company = String(req.body?.company ?? '').trim();
  if (!name || !company) {
    res.status(400).type('html').send('Name, work email, and company name are required. We email a verification link to the company work address. The sandbox Organization is created only after you verify.');
    return;
  }
  if (!companyEmailOk(req.body?.email)) {
    res.status(400).type('html').send('Use a company email. Gmail, Yahoo, Hotmail, Outlook, iCloud, and AOL are not accepted.');
    return;
  }
  res.redirect(303, '/trial/thanks/');
}

app.post('/trial/thanks', sandboxTrialPost);
app.post('/trial/thanks/', sandboxTrialPost);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
  );
  res.setHeader('Content-Security-Policy', CSP);
  if (req.path.startsWith('/api/')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (
    req.path === '/resources/ae-intake-checklist/thanks' ||
    req.path === '/resources/ae-intake-checklist/thanks/' ||
    req.path === '/trial/thanks' ||
    req.path === '/trial/thanks/'
  ) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  if (req.path === '/downloads/ae-intake-readiness-checklist.pdf') {
    res.setHeader('X-Robots-Tag', 'noindex');
  }
  if (req.path.startsWith('/vendor/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  const dest = LEGACY_REDIRECTS[req.path];
  if (dest) return res.redirect(301, dest);
  next();
});

const NAME_RE = /^[a-z0-9-]+$/;

app.all('/api/:name', async (req, res) => {
  const name = req.params.name;
  const file = path.join(FUNCTIONS_DIR, `${name}.ts`);
  if (!NAME_RE.test(name) || !fs.existsSync(file)) return res.status(404).json({ error: 'Unknown endpoint' });
  try {
    const mod = await import(pathToFileURL(file).href);
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
