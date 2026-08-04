import { prisma } from './_lib/prisma.js';
import { assertCanProcessCase, recordCaseProcessed, BillingBlocked } from './_lib/billing.js';
import { generateAssessment } from './_lib/claude.js';
import { writeAudit } from './_lib/audit.js';
import { getSession, parseBody, requireMethod, ok, bad, unauthorized, notFound, paymentRequired, serverError, type FnEvent } from './_lib/http.js';

export async function handler(event: FnEvent) {
  const mth = requireMethod(event, 'POST');
  if (mth) return mth;
  const session = getSession(event);
  if (!session) return unauthorized();
  const userId = session.id;

  const { caseId } = parseBody<{ caseId?: string }>(event);
  if (!caseId) return bad('caseId is required');

  const c = await prisma.case.findFirst({ where: { id: caseId, userId } });
  if (!c) return notFound('Case not found');
  if (c.lockedAt) return bad('Case is signed off and locked', 'LOCKED');

  // Billing gate — BEFORE the Claude call (spec §5, do-not-lose #3).
  let shouldMeter = false;
  try {
    ({ shouldMeter } = await assertCanProcessCase(userId, c));
  } catch (err) {
    if (err instanceof BillingBlocked) return paymentRequired({ error: err.message, code: err.code });
    throw err;
  }

  let result;
  try {
    result = await generateAssessment(c.sourceText);
  } catch (err: any) {
    return serverError('AI assessment failed: ' + (err?.message || 'unknown error'));
  }

  const assessment = await prisma.assessment.create({
    data: {
      caseId: c.id,
      userId,
      modelVersion: result.modelVersion,
      seriousness: result.seriousness,
      meddraPt: result.meddraPt,
      meddraCode: result.meddraCode,
      soc: result.soc,
      causality: result.causality,
      causalityMethod: result.causalityMethod,
      expectedness: result.expectedness,
      regulatoryRequired: result.regulatoryRequired,
      regulatoryTimeline: result.regulatoryTimeline,
      authorities: JSON.stringify(result.authorities),
      narrative: result.narrative,
      // Store confidence + per-field rationale together (no extra column needed).
      confidenceJson: JSON.stringify({ confidence: result.confidence, rationale: result.rationale }),
    },
  });

  await prisma.case.update({ where: { id: c.id }, data: { status: 'in_review' } });

  if (shouldMeter) await recordCaseProcessed(userId, c);

  await writeAudit({
    userId,
    caseId: c.id,
    action: 'AI_ASSESSMENT',
    detail: { metered: shouldMeter, modelVersion: result.modelVersion },
  });

  return ok({
    assessmentId: assessment.id,
    metered: shouldMeter,
    modelVersion: result.modelVersion,
    assessment: {
      seriousness: result.seriousness,
      meddraPt: result.meddraPt,
      meddraCode: result.meddraCode,
      soc: result.soc,
      causality: result.causality,
      expectedness: result.expectedness,
      regulatoryRequired: result.regulatoryRequired,
      regulatoryTimeline: result.regulatoryTimeline,
      authorities: result.authorities,
      narrative: result.narrative,
      confidence: result.confidence,
      rationale: result.rationale,
    },
  });
}
