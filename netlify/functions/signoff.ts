import bcrypt from 'bcryptjs';
import { prisma } from './_lib/prisma.js';
import { writeAudit } from './_lib/audit.js';
import { getSession, parseBody, requireMethod, ok, bad, unauthorized, notFound, conflict, type FnEvent } from './_lib/http.js';

/**
 * Human e-signature sign-off (spec §6, do-not-lose #1) — the hard, non-bypassable
 * gate. The AI output is only ever a draft; a qualified reviewer must sign off,
 * which LOCKS the case (status = cleared).
 */
const STATEMENT =
  'I certify that I have reviewed this adverse-event case and its AI-drafted assessment, and I approve it as cleared.';

export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;
  const session = getSession(event);
  if (!session) return unauthorized();
  const userId = session.id;

  const { caseId, pin } = parseBody<{ caseId?: string; pin?: string }>(event);
  if (!caseId) return bad('caseId is required');

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, esignaturePinHash: true } });
  if (!user?.esignaturePinHash) {
    return bad('Set an e-signature PIN before signing off.', 'NO_ESIGNATURE');
  }
  if (!pin || !(await bcrypt.compare(pin, user.esignaturePinHash))) {
    return unauthorized('Invalid e-signature PIN');
  }

  const c = await prisma.case.findFirst({
    where: { id: caseId, userId },
    include: { assessments: { take: 1 } },
  });
  if (!c) return notFound('Case not found');
  if (c.lockedAt) return conflict('Case is already signed off and locked', 'ALREADY_LOCKED');
  if (c.assessments.length === 0) return conflict('Case must be assessed before sign-off', 'NOT_ASSESSED');

  const signedAt = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const auditHash = await writeAudit(
      { userId, caseId: c.id, action: 'SIGNED_OFF', detail: { signerName: user.name, statement: STATEMENT, signedAt: signedAt.toISOString() } },
      tx,
    );
    const esignatureMeta = JSON.stringify({ signerName: user.name, statement: STATEMENT, signedAt: signedAt.toISOString(), boundAuditHash: auditHash });
    await tx.case.update({
      where: { id: c.id },
      data: { status: 'cleared', signedOffAt: signedAt, lockedAt: signedAt, esignatureMeta },
    });
    return { esignatureMeta };
  });

  return ok({ success: true, caseId: c.id, status: 'cleared', signedOffAt: signedAt, signature: JSON.parse(result.esignatureMeta) });
}
