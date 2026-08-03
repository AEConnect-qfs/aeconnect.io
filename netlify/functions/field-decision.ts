import { prisma } from './_lib/prisma.js';
import { writeAudit } from './_lib/audit.js';
import { getSession, parseBody, requireMethod, ok, bad, unauthorized, notFound, conflict, type FnEvent } from './_lib/http.js';

/**
 * Reviewer accepts or overrides a single AI-drafted field (spec §5). Recorded to
 * field_decisions + the hash-chained audit log. Rejected once the case is locked.
 */
export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;
  const session = getSession(event);
  if (!session) return unauthorized();
  const userId = session.id;

  const { caseId, fieldKey, decisionType, aiValue, finalValue, reason } = parseBody<{
    caseId?: string; fieldKey?: string; decisionType?: string;
    aiValue?: string; finalValue?: string; reason?: string;
  }>(event);

  if (!caseId || !fieldKey || !decisionType) return bad('caseId, fieldKey and decisionType are required');
  if (decisionType !== 'accept' && decisionType !== 'override') return bad("decisionType must be 'accept' or 'override'");
  if (decisionType === 'override' && (finalValue === undefined || finalValue === '')) {
    return bad('finalValue is required for an override');
  }

  const c = await prisma.case.findFirst({ where: { id: caseId, userId }, select: { id: true, lockedAt: true } });
  if (!c) return notFound('Case not found');
  if (c.lockedAt) return conflict('Case is signed off and locked', 'LOCKED');

  const finalVal = decisionType === 'accept' ? (aiValue ?? '') : (finalValue as string);
  const decision = await prisma.fieldDecision.create({
    data: { caseId: c.id, userId, fieldKey, decisionType, aiValue: aiValue ?? '', finalValue: finalVal, reason: reason || null },
  });
  await writeAudit({
    userId, caseId: c.id, action: 'FIELD_DECISION',
    detail: { fieldKey, decisionType, finalValue: finalVal, reason: reason || null },
  });

  return ok({ id: decision.id, fieldKey, decisionType, finalValue: finalVal });
}
