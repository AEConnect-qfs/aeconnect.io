import { prisma } from './_lib/prisma.js';
import { assertCanProcessCase, recordCaseProcessed, BillingBlocked } from './_lib/billing.js';
import { assessCase, AssessmentError } from './_lib/assessment.js';
import { writeAudit } from './_lib/audit.js';
import { getSession, parseBody, requireMethod, ok, bad, unauthorized, notFound, paymentRequired, serverError, json, type FnEvent } from './_lib/http.js';

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

  // Billing gate — before any model call. A rejected draft never reaches this meter.
  let shouldMeter = false;
  try {
    ({ shouldMeter } = await assertCanProcessCase(userId, c));
  } catch (err) {
    if (err instanceof BillingBlocked) return paymentRequired({ error: err.message, code: err.code });
    throw err;
  }

  let result;
  try {
    result = await assessCase(c.sourceText);
  } catch (err) {
    const detail = err instanceof AssessmentError ? err.detail : err instanceof Error ? err.message : String(err);
    console.error('[assess]', detail);
    if (err instanceof AssessmentError && err.kind === 'invalid_draft') {
      return json(422, { error: 'The assessment draft was invalid and was not saved.', code: 'INVALID_DRAFT' });
    }
    return serverError('AI assessment failed');
  }

  const assessment = await prisma.assessment.create({
    data: {
      caseId: c.id,
      userId,
      modelVersion: result.modelVersion,
      promptVersion: result.promptVersion,
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
      // Store confidence + per-field rationale + references together (no extra column needed).
      confidenceJson: JSON.stringify({ confidence: result.confidence, rationale: result.rationale, references: result.references }),
    },
  });

  await prisma.case.update({ where: { id: c.id }, data: { status: 'in_review' } });

  if (shouldMeter) await recordCaseProcessed(userId, c);

  await writeAudit({
    userId,
    caseId: c.id,
    action: 'AI_ASSESSMENT',
    detail: { metered: shouldMeter, modelVersion: result.modelVersion, promptVersion: result.promptVersion },
  });

  return ok({
    assessmentId: assessment.id,
    metered: shouldMeter,
    modelVersion: result.modelVersion,
    promptVersion: result.promptVersion,
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
      references: result.references,
    },
  });
}
