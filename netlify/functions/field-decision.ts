import { prisma } from './_lib/prisma.js';
import { writeAudit } from './_lib/audit.js';
import { requireSession, isResponse, parseBody, requireMethod, ok, bad, notFound, conflict, type FnEvent } from './_lib/http.js';

/**
 * Reviewer accepts or overrides one field of the latest assessment. The decision
 * is stored against that assessment id so a later re-run does not inherit it.
 */
export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;
  const session = await requireSession(event);
  if (isResponse(session)) return session;
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

  const latest = await prisma.assessment.findFirst({
    where: { caseId: c.id, userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!latest) return bad('Assess the case before reviewing fields', 'NO_ASSESSMENT');

  const finalVal = decisionType === 'accept' ? (aiValue ?? '') : (finalValue as string);
  const decision = await prisma.fieldDecision.create({
    data: {
      caseId: c.id,
      userId,
      fieldKey,
      decisionType,
      aiValue: aiValue ?? '',
      finalValue: finalVal,
      reason: reason || null,
      assessmentId: latest.id,
    },
  });
  await writeAudit({
    userId, caseId: c.id, action: 'FIELD_DECISION',
    detail: { fieldKey, decisionType, finalValue: finalVal, reason: reason || null },
  });

  return ok({ id: decision.id, fieldKey, decisionType, finalValue: finalVal, assessmentId: latest.id });
}
