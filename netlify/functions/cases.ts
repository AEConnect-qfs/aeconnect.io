import { prisma } from './_lib/prisma.js';
import { writeAudit } from './_lib/audit.js';
import { getSession, parseBody, ok, bad, unauthorized, notFound, json, type FnEvent } from './_lib/http.js';

export async function handler(event: FnEvent) {
  const session = getSession(event);
  if (!session) return unauthorized();
  const userId = session.id;

  // GET /api/cases            → list
  // GET /api/cases?id=<id>    → one (with latest assessment + field decisions)
  if (event.httpMethod === 'GET') {
    const id = event.queryStringParameters?.id;
    if (id) {
      const c = await prisma.case.findFirst({
        where: { id, userId },
        include: {
          assessments: { orderBy: { createdAt: 'desc' }, take: 1 },
          fieldDecisions: { orderBy: { decidedAt: 'desc' } },
        },
      });
      if (!c) return notFound('Case not found');
      let assessment = null;
      if (c.assessments[0]) {
        const row = c.assessments[0];
        // confidenceJson holds either the new { confidence, rationale } shape or an old flat confidence map.
        const detail: any = safeObj(row.confidenceJson);
        const confidence = detail && typeof detail.confidence === 'object' ? detail.confidence : detail;
        const rationale = detail && typeof detail.rationale === 'object' ? detail.rationale : {};
        const references = detail && Array.isArray(detail.references) ? detail.references : [];
        assessment = { ...row, authorities: safeArr(row.authorities), confidence, rationale, references };
      }
      return ok({
        id: c.id, caseRef: c.caseRef, title: c.title, status: c.status,
        sourceType: c.sourceType, sourceText: c.sourceText,
        signedOffAt: c.signedOffAt, lockedAt: c.lockedAt,
        esignature: c.esignatureMeta ? JSON.parse(c.esignatureMeta) : null,
        assessment, fieldDecisions: c.fieldDecisions,
      });
    }
    const cases = await prisma.case.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, caseRef: true, title: true, status: true, createdAt: true, signedOffAt: true },
    });
    return ok({ cases });
  }

  // POST /api/cases → create
  if (event.httpMethod === 'POST') {
    const { title, sourceText, sourceType } = parseBody<{ title?: string; sourceText?: string; sourceType?: string }>(event);
    if (!sourceText || !sourceText.trim()) return bad('sourceText is required');

    const count = await prisma.case.count({ where: { userId } });
    const caseRef = `CASE-${String(count + 1).padStart(4, '0')}`;
    const c = await prisma.case.create({
      data: {
        userId,
        caseRef,
        title: (title && title.trim()) || caseRef,
        sourceText,
        sourceType: sourceType || 'text',
        status: 'pending',
      },
    });
    await writeAudit({ userId, caseId: c.id, action: 'CASE_CREATED', detail: { caseRef } });
    return ok({ id: c.id, caseRef: c.caseRef, title: c.title, status: c.status });
  }

  return json(405, { error: `Method ${event.httpMethod} not allowed` });
}

function safeArr(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
function safeObj(s: string): Record<string, string> {
  try { return JSON.parse(s) || {}; } catch { return {}; }
}
