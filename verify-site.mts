import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from './netlify/functions/_lib/prisma.js';
import { verifyAuditChain } from './netlify/functions/_lib/audit.js';
import { currentBillingMonth } from './netlify/functions/_lib/billing.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Netlify matches `/path` and `/path/` as the same redirect rule. A force rule whose
 *  destination only adds a slash therefore 301s the canonical URL to itself. */
function checkNetlifyRedirects() {
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const rules: { from: string; to: string; force: boolean }[] = [];
  for (const block of toml.split('[[redirects]]').slice(1)) {
    const from = block.match(/from = "([^"]*)"/)?.[1];
    const to = block.match(/to = "([^"]*)"/)?.[1];
    if (!from || !to || from.includes('://') || from.includes('*')) continue;
    rules.push({ from, to, force: /force = true/.test(block.split('[[')[0]) });
  }
  const norm = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
  const hasPage = (urlPath: string) => {
    if (urlPath === '/' || urlPath.endsWith('/')) {
      const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1) + 'index.html';
      return fs.existsSync(path.join(ROOT, rel));
    }
    return fs.existsSync(path.join(ROOT, urlPath.slice(1)));
  };
  const follow = (start: string) => {
    let current = start;
    const seen = new Set<string>();
    let hops = 0;
    for (;;) {
      if (seen.has(current)) return { status: 0, hops, final: current, loop: true };
      seen.add(current);
      const rule = rules.find((r) => norm(r.from) === norm(current));
      if (rule && (rule.force || !hasPage(current))) {
        hops++;
        if (hops > 2 || norm(rule.to) === norm(current)) return { status: 301, hops, final: rule.to, loop: true };
        current = rule.to;
        continue;
      }
      if (current !== '/' && !current.endsWith('/') && hasPage(current + '/')) {
        hops++;
        current = current + '/';
        continue;
      }
      return { status: hasPage(current) ? 200 : 404, hops, final: current, loop: false };
    }
  };
  const locs = [...fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  let ok = true;
  const bad: string[] = [];
  for (const p of locs) {
    const slash = follow(p);
    if (slash.loop || slash.status !== 200 || slash.hops !== 0) {
      ok = false;
      bad.push(`${p} → ${slash.status} hops=${slash.hops} loop=${slash.loop}`);
    }
    if (p !== '/') {
      const bare = follow(p.slice(0, -1));
      if (bare.loop || bare.status !== 200 || bare.hops !== 1 || bare.final !== p) {
        ok = false;
        bad.push(`${p.slice(0, -1)} → ${bare.final} hops=${bare.hops} loop=${bare.loop}`);
      }
    }
  }
  const legacy = [
    ['/blog/meddra-coding-at-intake-ai-pharmacovigilance', '/blog/the-missing-layer-in-pharmacovigilance-ae-connect/'],
    ['/blog/meddra-coding-at-intake-ai-pharmacovigilance/', '/blog/the-missing-layer-in-pharmacovigilance-ae-connect/'],
    ['/adverse-event-intake-system', '/'],
    ['/adverse-event-intake-system/', '/'],
    ['/blog/safety-database-comparison-argus-veeva-reportum-ae-connect', '/blog/veeva-argus-overkill-early-phase-biotech/'],
    ['/blog/safety-database-comparison-argus-veeva-reportum-ae-connect/', '/blog/veeva-argus-overkill-early-phase-biotech/'],
    ['/blog/oracle-argus-alternative', '/blog/oracle-argus/'],
    ['/blog/oracle-argus-alternative/', '/blog/oracle-argus/'],
    ['/blog/arisglobal-lifesphere-alternative', '/blog/arisglobal-lifesphere/'],
    ['/blog/arisglobal-lifesphere-alternative/', '/blog/arisglobal-lifesphere/'],
    ['/blog/veeva-vault-safety-alternative', '/blog/veeva-vault-safety/'],
    ['/blog/veeva-vault-safety-alternative/', '/blog/veeva-vault-safety/'],
  ];
  for (const [from, to] of legacy) {
    const r = follow(from);
    const dest = follow(to);
    if (r.loop || r.hops !== 1 || r.final !== to || dest.loop || dest.status !== 200 || dest.hops !== 0) {
      ok = false;
      bad.push(`legacy ${from} → ${r.final} hops=${r.hops}; dest ${dest.status}`);
    }
  }
  check('netlify redirects: slash 200, one hop, no loops', ok, bad.slice(0, 4).join('; '));
}

const B = `http://localhost:${process.env.PORT || 8787}`;
const EMAIL = `verify-${Date.now()}@x.io`;
let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); c ? pass++ : fail++; };

async function api(path: string, method: string, token?: string, body?: object) {
  const res = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const robots = res.headers.get('x-robots-tag') || '';
  return { status: res.status, body: await res.json().catch(() => ({})), robots };
}

function locationPath(loc: string): string {
  if (!loc) return '';
  try { return new URL(loc, B).pathname; } catch { return loc; }
}

async function page(path: string) {
  const res = await fetch(B + path, { redirect: 'manual' });
  return {
    status: res.status,
    loc: locationPath(res.headers.get('location') || ''),
    csp: res.headers.get('content-security-policy') || '',
    text: await res.text(),
  };
}

async function main() {
  checkNetlifyRedirects();

  const home = await page('/');
  check('home 200 with self-canonical', home.status === 200 && home.text.includes('rel="canonical" href="https://aeconnect.io/"') && !home.csp.includes('upgrade-insecure-requests'));

  const aboutBare = await page('/about');
  const about = await page('/about/');
  check('trailing slash: /about → /about/', aboutBare.status === 301 && aboutBare.loc === '/about/' && about.status === 200);

  const legacy = [
    ['/blog/meddra-coding-at-intake-ai-pharmacovigilance', '/blog/the-missing-layer-in-pharmacovigilance-ae-connect/'],
    ['/adverse-event-intake-system/', '/'],
    ['/blog/safety-database-comparison-argus-veeva-reportum-ae-connect', '/blog/veeva-argus-overkill-early-phase-biotech/'],
  ] as const;
  for (const [from, to] of legacy) {
    const r = await page(from);
    check(`301 ${from}`, r.status === 301 && r.loc === to, r.loc);
  }

  for (const p of ['/blog/ae-intake-vs-pharmacovigilance/', '/blog/drug-safety-inbox-small-biotech-reality/', '/blog/pv-plan-first-ind-what-small-biotechs-get-wrong/', '/blog/pv-case-intake-forms/', '/blog/oracle-argus/', '/pricing/', '/demo/', '/solutions/pv-case-intake/', '/integrations/oracle-argus/', '/trust/', '/privacy/', '/terms/', '/app/']) {
    const r = await page(p);
    const canon = `https://aeconnect.io${p}`;
    check(`200 ${p}`, r.status === 200 && r.text.includes(`rel="canonical" href="${canon}"`));
  }

  const robots = await page('/robots.txt');
  const sitemap = await page('/sitemap.xml');
  const locs = sitemap.text.match(/<loc>/g)?.length || 0;
  check('robots disallows /api/', robots.status === 200 && robots.text.includes('Disallow: /api/'));
  check('sitemap lists every public URL with lastmod', sitemap.status === 200 && locs === 41 && (sitemap.text.match(/<lastmod>/g)?.length || 0) === 41);

  const weak = await api('/api/signup', 'POST', undefined, { email: 'not-an-email', password: 'short', name: 'A' });
  check('signup weak password + bad email → 400', weak.status === 400 && !!weak.body.fields?.password && !!weak.body.fields?.email && weak.robots.includes('noindex'));
  const loginBad = await api('/api/login', 'POST', undefined, { email: 'also-bad', password: '' });
  check('login empty password → 400', loginBad.status === 400 && !!loginBad.body.fields?.password);

  // signup — password123 (11 chars, letter + number) must still pass the policy
  const su = await api('/api/signup', 'POST', undefined, { email: EMAIL, password: 'password123', name: 'Verify User' });
  const token = su.body.token as string;
  check('signup → token + trial plan', su.status === 200 && !!token && su.body.user.plan === 'trial');

  const li = await api('/api/login', 'POST', undefined, { email: EMAIL, password: 'password123' });
  const liBad = await api('/api/login', 'POST', undefined, { email: EMAIL, password: 'wrong-password' });
  check('login correct password → token', li.status === 200 && !!li.body.token);
  check('login wrong password → 401', liBad.status === 401 && liBad.body.error === 'Invalid credentials');

  const shortCase = await api('/api/cases', 'POST', token, { sourceText: 'too short', sourceType: 'nope', fileName: 'payload.exe', fileSize: 11 * 1024 * 1024 });
  check('case: short text, bad type, oversize → 400', shortCase.status === 400 && !!shortCase.body.fields?.sourceText && !!shortCase.body.fields?.sourceType && !!shortCase.body.fields?.file);

  // create + assess 5 cases (trial = 5)
  const caseIds: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const c = await api('/api/cases', 'POST', token, { title: `Case ${i}`, sourceText: `Patient reported headache after dose ${i}. Hospitalized.` });
    caseIds.push(c.body.id);
    const a = await api('/api/assess', 'POST', token, { caseId: c.body.id });
    if (i === 1) check('assess → structured draft + metered + confidence', a.status === 200 && a.body.metered === true && !!a.body.assessment.confidence.seriousness);
  }

  // 6th case: assess blocked by trial gate (402)
  const c6 = await api('/api/cases', 'POST', token, { title: 'Case 6', sourceText: 'Mild nausea after dose 6.' });
  const a6 = await api('/api/assess', 'POST', token, { caseId: c6.body.id });
  check('trial: 6th assess → 402 TRIAL_EXHAUSTED', a6.status === 402 && a6.body.code === 'TRIAL_EXHAUSTED');

  const usage1 = await api('/api/usage', 'GET', token);
  check('usage: trial 5/5 used, 0 remaining', usage1.body.trial?.used === 5 && usage1.body.trial?.remaining === 0);

  // re-assess an already-assessed case is free (not re-metered)
  const rerun = await api('/api/assess', 'POST', token, { caseId: caseIds[0] });
  check('rerun assess → not metered', rerun.status === 200 && rerun.body.metered === false);

  // field decisions: accept + override
  const acc = await api('/api/field-decision', 'POST', token, { caseId: caseIds[0], fieldKey: 'meddraPt', decisionType: 'accept', aiValue: 'Headache' });
  const ovr = await api('/api/field-decision', 'POST', token, { caseId: caseIds[0], fieldKey: 'seriousness', decisionType: 'override', aiValue: 'Serious', finalValue: 'Non-serious', reason: 'No hospitalization confirmed' });
  check('field decision: accept + override recorded', acc.status === 200 && ovr.status === 200 && ovr.body.finalValue === 'Non-serious');

  // E-signature sign-off was removed from this site (it lives on app.aeconnect.io).
  const pin = await api('/api/set-pin', 'POST', token, { pin: '1234' });
  const so = await api('/api/signoff', 'POST', token, { caseId: caseIds[0], pin: '1234' });
  check('sign-off endpoints stay removed', pin.status === 404 && so.status === 404);
  const saved = await api('/api/cases?id=' + caseIds[0], 'GET', token);
  check('field decisions persist on the case', saved.status === 200 && Array.isArray(saved.body.fieldDecisions) && saved.body.fieldDecisions.length >= 2);

  // subscribe → core, then overage past included limit
  const sub = await api('/api/create-checkout-session', 'POST', token);
  check('subscribe (dev activate) → core plan', sub.status === 200 && sub.body.plan === 'core');

  // simulate month already at included limit, then assess the previously-blocked case 6
  const userId = su.body.user.id;
  await prisma.billingUsage.update({
    where: { userId_billingMonth: { userId, billingMonth: currentBillingMonth() } },
    data: { casesProcessed: 25, overageCases: 0, amountDueCents: 0 },
  });
  const a6b = await api('/api/assess', 'POST', token, { caseId: c6.body.id });
  const usage2 = await api('/api/usage', 'GET', token);
  check('overage: case 26 bills $1 → est $21.00', a6b.status === 200 && usage2.body.overageCases === 1 && usage2.body.estimatedAmountDue === '$21.00', usage2.body.estimatedAmountDue);

  // audit chain intact
  const chain = await verifyAuditChain(userId);
  check('audit: hash chain verifies', chain.ok, chain.brokenAt || '');

  // cleanup
  await prisma.user.delete({ where: { id: userId } });

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
