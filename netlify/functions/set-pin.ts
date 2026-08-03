import bcrypt from 'bcryptjs';
import { prisma } from './_lib/prisma.js';
import { getSession, parseBody, requireMethod, ok, bad, unauthorized, type FnEvent } from './_lib/http.js';

// Set/replace the caller's e-signature PIN (spec §6). Re-entered at sign-off.
export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;
  const session = getSession(event);
  if (!session) return unauthorized();

  const { pin } = parseBody<{ pin?: string }>(event);
  if (!pin || pin.length < 4) return bad('PIN must be at least 4 characters');

  await prisma.user.update({ where: { id: session.id }, data: { esignaturePinHash: await bcrypt.hash(pin, 10) } });
  return ok({ success: true });
}
