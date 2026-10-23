import 'dotenv/config';
import { prisma } from './netlify/functions/_lib/prisma.js';
import { verifyAuditChain } from './netlify/functions/_lib/audit.js';
import { currentBillingMonth } from './netlify/functions/_lib/billing.js';

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

  for (const p of ['/blog/ae-intake-vs-pharmacovigilance/', '/blog/drug-safety-inbox-small-biotech-reality/', '/blog/pv-plan-first-ind-what-small-biotechs-get-wrong/', '/privacy/', '/terms/', '/app/']) {
    const r = await page(p);
    const canon = `https://aeconnect.io${p}`;
    check(`200 ${p}`, r.status === 200 && r.text.includes(`rel="canonical" href="${canon}"`));
  }

  const robots = await page('/robots.txt');
  const sitemap = await page('/sitemap.xml');
  const locs = sitemap.text.match(/<loc>/g)?.length || 0;
  check('robots disallows /api/', robots.status === 200 && robots.text.includes('Disallow: /api/'));
  check('sitemap lists every public URL with lastmod', sitemap.status === 200 && locs === 16 && (sitemap.text.match(/<lastmod>/g)?.length || 0) === 16);

  const weak = await api('/api/signup', 'POST', undefined, { email: 'not-an-email', password: 'short', name: 'A' });
  check('signup weak password + bad email → 400', weak.status === 400 && !!weak.body.fields?.password && !!weak.body.fields?.email && weak.robots.includes('noindex'));
  const loginBad = await api('/api/login', 'POST', undefined, { email: 'also-bad', password: '' });
  check('login empty password → 400', loginBad.status === 400 && !!loginBad.body.fields?.password);

  // signup — password123 (11 chars, letter + number) must still pass the policy
  const su = await api('/api/signup', 'POST', undefined, { email: EMAIL, password: 'password123', name: 'Verify User' });
  const token = su.body.token as string;
  check('signup → token + trial plan', su.status === 200 && !!token && su.body.user.plan === 'trial');

  const shortCase = await api('/api/cases', 'POST', token, { sourceText: 'too short', sourceType: 'nope', fileName: 'payload.exe', fileSize: 11 * 1024 * 1024 });
  check('case: short text, bad type, oversize → 400', shortCase.status === 400 && !!shortCase.body.fields?.sourceText && !!shortCase.body.fields?.sourceType && !!shortCase.body.fields?.file);

  await api('/api/set-pin', 'POST', token, { pin: '1234' });

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

  // sign-off: wrong pin then correct
  const bad = await api('/api/signoff', 'POST', token, { caseId: caseIds[0], pin: '9999' });
  check('signoff wrong PIN → 401', bad.status === 401);
  const so = await api('/api/signoff', 'POST', token, { caseId: caseIds[0], pin: '1234' });
  check('signoff correct PIN → cleared + locked + signature', so.status === 200 && so.body.status === 'cleared' && !!so.body.signature.boundAuditHash);

  // locked case rejects further edits
  const lockAssess = await api('/api/assess', 'POST', token, { caseId: caseIds[0] });
  const lockField = await api('/api/field-decision', 'POST', token, { caseId: caseIds[0], fieldKey: 'soc', decisionType: 'accept', aiValue: 'x' });
  const reSign = await api('/api/signoff', 'POST', token, { caseId: caseIds[0], pin: '1234' });
  check('locked case: assess/field/re-signoff all rejected', lockAssess.status === 400 && lockField.status === 409 && reSign.status === 409);

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
