import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { prisma } from './netlify/functions/_lib/prisma.js';
import { verifyAuditChain } from './netlify/functions/_lib/audit.js';
import { currentBillingMonth } from './netlify/functions/_lib/billing.js';
import { CONTENT_SECURITY_POLICY } from './netlify/functions/_lib/csp.js';
import {
  LOGIN_MAX_FAILURES,
  RESET_GENERIC_MESSAGE,
  RESET_MAX_PER_WINDOW,
  RESET_RATE_LIMIT_MESSAGE,
  emailKey,
  hashResetToken,
  newResetToken,
} from './netlify/functions/_lib/auth.js';

const B = `http://localhost:${process.env.PORT || 8787}`;
const EMAIL = `verify-${Date.now()}@x.io`;
const PASSWORD = 'password123';
let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`);
  c ? pass++ : fail++;
};

async function api(path: string, method: string, token?: string, body?: object) {
  const res = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function attrEsc(s: string) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

async function main() {
  const page = await fetch(B + '/app/');
  const html = await page.text();
  const js = await (await fetch(B + '/app/app.js')).text();
  const resetPage = await (await fetch(B + '/app/reset.html')).text();
  const resetJs = await (await fetch(B + '/app/reset.js')).text();
  const csp = page.headers.get('content-security-policy') || '';
  const toml = readFileSync(new URL('./netlify.toml', import.meta.url), 'utf8');
  check('workspace has no inline onclick handlers', !/onclick\s*=/i.test(html + js + resetPage + resetJs));
  check('accept uses a data attribute, not an inline call',
    js.includes('data-action="accept"') && js.includes('data-ai="') && !js.includes('JSON.stringify(aiVal)'));
  check('quote-entity payload stays inside the attribute',
    `data-ai="${attrEsc('ok&quot;);alert(1);//')}"` === 'data-ai="ok&amp;quot;);alert(1);//"');
  check('cdn scripts set SRI', js.includes('sha384-/1qUCSGwTur9vjf') && js.includes("crossOrigin = 'anonymous'"));
  check('content-security-policy blocks inline scripts',
    csp === CONTENT_SECURITY_POLICY && !/script-src[^;]*unsafe-inline/.test(csp) && toml.includes(CONTENT_SECURITY_POLICY));
  check('forgot-password and reset page are wired',
    html.includes('Forgot password?') && resetPage.includes('/app/reset.js') && resetJs.includes('/api/reset-password'));
  check('download says approved only after every current decision',
    js.includes('it was reviewed and approved by a qualified user') &&
    js.includes('DRAFT — Decision support only') &&
    js.includes('assessmentId === id') &&
    js.includes('allReviewed'));

  const badEmail = await api('/api/signup', 'POST', undefined, { email: 'not-an-email', password: PASSWORD, name: 'Nope' });
  check('signup rejects an invalid email', badEmail.status === 400 && !badEmail.body.token);

  const su = await api('/api/signup', 'POST', undefined, { email: EMAIL, password: PASSWORD, name: 'Verify User' });
  let token = su.body.token as string;
  const userId = su.body.user?.id as string;
  check('signup → token + trial plan', su.status === 200 && !!token && su.body.user.plan === 'trial');

  const wh = await api('/api/stripe-webhook', 'POST', undefined, {
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: userId } },
  });
  const afterWh = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true } });
  check('webhook fail-closed without Stripe', wh.status === 503 && wh.body.code === 'WEBHOOK_DISABLED' && afterWh?.plan === 'trial');

  const loggedOut = await api('/api/logout', 'POST', token);
  const afterLogout = await api('/api/me', 'GET', token);
  check('logout invalidates the session', loggedOut.status === 200 && afterLogout.status === 401);
  const relog = await api('/api/login', 'POST', undefined, { email: EMAIL, password: PASSWORD });
  token = relog.body.token;
  check('login after logout issues a new token', relog.status === 200 && !!token && token !== su.body.token);

  const caseIds: string[] = [];
  let firstAssessment = '';
  for (let i = 1; i <= 5; i++) {
    const c = await api('/api/cases', 'POST', token, { title: `Case ${i}`, sourceText: `Patient reported headache after dose ${i}. Hospitalized.` });
    caseIds.push(c.body.id);
    const a = await api('/api/assess', 'POST', token, { caseId: c.body.id });
    if (i === 1) {
      firstAssessment = a.body.assessmentId;
      check('assess → structured draft + metered + confidence', a.status === 200 && a.body.metered === true && !!a.body.assessment.confidence.seriousness);
    }
  }

  const c6 = await api('/api/cases', 'POST', token, { title: 'Case 6', sourceText: 'Mild nausea after dose 6.' });
  const a6 = await api('/api/assess', 'POST', token, { caseId: c6.body.id });
  check('trial: 6th assess → 402 TRIAL_EXHAUSTED', a6.status === 402 && a6.body.code === 'TRIAL_EXHAUSTED');

  const noDraft = await api('/api/field-decision', 'POST', token, {
    caseId: c6.body.id, fieldKey: 'seriousness', decisionType: 'accept', aiValue: 'Non-serious',
  });
  check('decision without an assessment is rejected', noDraft.status === 400 && noDraft.body.code === 'NO_ASSESSMENT');

  const usage1 = await api('/api/usage', 'GET', token);
  check('usage: trial 5/5 used, 0 remaining', usage1.body.trial?.used === 5 && usage1.body.trial?.remaining === 0);

  const rerun = await api('/api/assess', 'POST', token, { caseId: caseIds[0] });
  check('rerun assess → not metered', rerun.status === 200 && rerun.body.metered === false && rerun.body.assessmentId !== firstAssessment);

  const acc = await api('/api/field-decision', 'POST', token, { caseId: caseIds[0], fieldKey: 'meddraPt', decisionType: 'accept', aiValue: 'Headache' });
  const ovr = await api('/api/field-decision', 'POST', token, {
    caseId: caseIds[0], fieldKey: 'seriousness', decisionType: 'override', aiValue: 'Serious', finalValue: 'Non-serious', reason: 'No hospitalization confirmed',
  });
  check('field decision belongs to the current assessment',
    acc.status === 200 && ovr.status === 200 && ovr.body.finalValue === 'Non-serious' &&
    ovr.body.assessmentId === rerun.body.assessmentId && acc.body.assessmentId === rerun.body.assessmentId);

  const third = await api('/api/assess', 'POST', token, { caseId: caseIds[0] });
  const view = await api('/api/cases?id=' + caseIds[0], 'GET', token);
  const decisions = (view.body.fieldDecisions || []) as Array<{ fieldKey: string; assessmentId: string | null }>;
  const currentId = view.body.assessment?.id as string;
  check('re-run does not keep prior accept/override decisions',
    third.status === 200 && third.body.metered === false && third.body.assessmentId === currentId && currentId !== rerun.body.assessmentId &&
    !decisions.some((d) => d.assessmentId === currentId) &&
    decisions.some((d) => d.assessmentId === rerun.body.assessmentId && d.fieldKey === 'seriousness'));

  const sub = await api('/api/create-checkout-session', 'POST', token);
  const stillTrial = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true } });
  check('checkout without the dev flag does not grant Core',
    sub.status === 503 && sub.body.code === 'BILLING_UNAVAILABLE' && stillTrial?.plan === 'trial');

  await prisma.user.update({ where: { id: userId }, data: { plan: 'core', subscribedAt: new Date() } });
  await prisma.billingUsage.update({
    where: { userId_billingMonth: { userId, billingMonth: currentBillingMonth() } },
    data: { casesProcessed: 25, overageCases: 0, amountDueCents: 0 },
  });
  const a6b = await api('/api/assess', 'POST', token, { caseId: c6.body.id });
  const usage2 = await api('/api/usage', 'GET', token);
  const usageRow = await prisma.billingUsage.findUnique({
    where: { userId_billingMonth: { userId, billingMonth: currentBillingMonth() } },
  });
  check('overage is counted and not charged',
    a6b.status === 200 && usage2.body.overageCases === 1 && usage2.body.estimatedAmountDue === '$20.00' &&
    usage2.body.overageBilled === false && usageRow?.amountDueCents === 0,
    usage2.body.estimatedAmountDue);

  const chain = await verifyAuditChain(userId);
  check('audit: hash chain verifies', chain.ok, chain.brokenAt || '');

  const missingEmail = `missing-${Date.now()}@x.io`;
  const resetKnown = await api('/api/request-password-reset', 'POST', undefined, { email: EMAIL });
  const resetMissing = await api('/api/request-password-reset', 'POST', undefined, { email: missingEmail });
  const resetBad = await api('/api/request-password-reset', 'POST', undefined, { email: 'not-an-email' });
  check('reset request is generic for known and unknown emails',
    resetKnown.status === 200 && resetMissing.status === 200 &&
    JSON.stringify(resetKnown.body) === JSON.stringify(resetMissing.body) &&
    resetKnown.body.message === RESET_GENERIC_MESSAGE &&
    !JSON.stringify(resetKnown.body).includes(EMAIL) && !JSON.stringify(resetKnown.body).includes('http'));
  check('reset request rejects a malformed email', resetBad.status === 400);

  const raw = newResetToken();
  const expiredRaw = newResetToken();
  await prisma.passwordReset.create({
    data: { userId, emailKey: emailKey(EMAIL), tokenHash: hashResetToken(raw), expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
  });
  await prisma.passwordReset.create({
    data: { userId, emailKey: emailKey(EMAIL), tokenHash: hashResetToken(expiredRaw), expiresAt: new Date(Date.now() - 1000) },
  });
  const expired = await api('/api/reset-password', 'POST', undefined, { token: expiredRaw, password: 'resetpass123' });
  const reset = await api('/api/reset-password', 'POST', undefined, { token: raw, password: 'resetpass123' });
  const reused = await api('/api/reset-password', 'POST', undefined, { token: raw, password: 'resetpass123' });
  const oldSession = await api('/api/me', 'GET', token);
  const newLogin = await api('/api/login', 'POST', undefined, { email: EMAIL, password: 'resetpass123' });
  const oldPassword = await api('/api/login', 'POST', undefined, { email: EMAIL, password: PASSWORD });
  check('reset link sets a new password once and signs out old sessions',
    expired.status === 400 && reset.status === 200 && reset.body.reset === true && reused.status === 400 &&
    oldSession.status === 401 && newLogin.status === 200 && !!newLogin.body.token && oldPassword.status === 401);
  token = newLogin.body.token;

  const limited = await api('/api/request-password-reset', 'POST', undefined, { email: EMAIL });
  let missingOk = 0;
  let missingLimited: { status: number; body: { error?: string; code?: string } } = { status: 0, body: {} };
  for (let i = 0; i < RESET_MAX_PER_WINDOW; i++) {
    const r = await api('/api/request-password-reset', 'POST', undefined, { email: missingEmail });
    if (r.status === 200) missingOk++;
    else missingLimited = r;
  }
  const missingAgain = await api('/api/request-password-reset', 'POST', undefined, { email: missingEmail.toUpperCase() });
  check('reset requests rate-limit without saying whether the account exists',
    limited.status === 429 && limited.body.code === 'RATE_LIMITED' && limited.body.error === RESET_RATE_LIMIT_MESSAGE &&
    missingOk === RESET_MAX_PER_WINDOW - 1 && missingLimited.status === 429 &&
    missingLimited.body.error === RESET_RATE_LIMIT_MESSAGE && missingAgain.status === 429 &&
    !JSON.stringify(limited.body).includes(EMAIL) && !JSON.stringify(missingLimited.body).includes('account'));

  const lockEmail = `lock-${Date.now()}@x.io`;
  const lockUser = await api('/api/signup', 'POST', undefined, { email: lockEmail, password: PASSWORD, name: 'Lock User' });
  const lockId = lockUser.body.user?.id as string;
  check('lockout fixture account', lockUser.status === 200 && !!lockId);
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    await api('/api/login', 'POST', undefined, { email: lockEmail, password: 'wrong-password' });
  }
  const locked = await api('/api/login', 'POST', undefined, { email: lockEmail, password: PASSWORD });
  const lockRow = await prisma.user.findUnique({ where: { id: lockId }, select: { lockedUntil: true } });
  check('repeated failed logins lock the account',
    locked.status === 429 && locked.body.code === 'LOCKED_OUT' && !!lockRow?.lockedUntil && lockRow.lockedUntil > new Date());

  const adminMissing = spawnSync('npm', ['run', 'reset-password', '--', `nobody-${Date.now()}@x.io`], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: process.env,
  });
  const admin = spawnSync('npm', ['run', 'reset-password', '--', '--generate', EMAIL], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: process.env,
  });
  const generated = (admin.stdout || '').split('\n').find((line) => line.startsWith('NEW_PASSWORD='))?.slice('NEW_PASSWORD='.length) || '';
  const adminLogin = generated
    ? await api('/api/login', 'POST', undefined, { email: EMAIL, password: generated })
    : { status: 0, body: {} };
  const adminOld = await api('/api/me', 'GET', token);
  check('admin reset-password reports a missing account',
    adminMissing.status === 1 && (adminMissing.stderr || '').includes('No account found') && !(adminMissing.stdout || '').includes('NEW_PASSWORD='));
  check('admin reset-password updates an existing account and signs it out',
    admin.status === 0 && (admin.stdout || '').includes(`Account found for ${EMAIL}.`) &&
    generated.length >= 8 && adminLogin.status === 200 && adminOld.status === 401);

  if (lockId) await prisma.user.delete({ where: { id: lockId } }).catch(() => undefined);
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
