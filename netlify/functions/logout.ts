import { prisma } from './_lib/prisma.js';
import { writeAudit } from './_lib/audit.js';
import { requireSession, isResponse, requireMethod, ok, type FnEvent } from './_lib/http.js';

/** Invalidate every token for this account, including the one calling logout. */
export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;
  const session = await requireSession(event);
  if (isResponse(session)) return session;

  await prisma.user.update({
    where: { id: session.id },
    data: { sessionVersion: { increment: 1 } },
  });
  await writeAudit({ userId: session.id, action: 'LOGOUT', detail: {} });
  return ok({ loggedOut: true });
}
