import { prisma } from './_lib/prisma.js';
import { requireSession, isResponse, requireMethod, ok, notFound, type FnEvent } from './_lib/http.js';

export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'GET');
  if (m) return m;
  const session = await requireSession(event);
  if (isResponse(session)) return session;

  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: { id: true, email: true, name: true, plan: true, esignaturePinHash: true },
  });
  if (!user) return notFound('Account not found');

  return ok({
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    hasEsignaturePin: !!user.esignaturePinHash,
  });
}
