import { prisma } from './_lib/prisma.js';
import { getSession, requireMethod, ok, unauthorized, notFound, type FnEvent } from './_lib/http.js';

export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'GET');
  if (m) return m;
  const session = getSession(event);
  if (!session) return unauthorized();

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
