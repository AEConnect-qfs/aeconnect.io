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
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  // signup
  const su = await api('/api/signup', 'POST', undefined, { email: EMAIL, password: 'password123', name: 'Verify User' });
  const token = su.body.token as string;
  check('signup → token + trial plan', su.status === 200 && !!token && su.body.user.plan === 'trial');

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
