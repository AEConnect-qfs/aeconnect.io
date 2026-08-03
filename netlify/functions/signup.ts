import bcrypt from 'bcryptjs';
import { prisma } from './_lib/prisma.js';
import { writeAudit } from './_lib/audit.js';
import { signToken, parseBody, requireMethod, ok, bad, json, type FnEvent } from './_lib/http.js';

export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;

  const { email, password, name } = parseBody<{ email?: string; password?: string; name?: string }>(event);
  if (!email || !password || !name) return bad('email, password and name are required');
  if (password.length < 8) return bad('Password must be at least 8 characters');

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return json(409, { error: 'An account with that email already exists' });

  const user = await prisma.user.create({
    data: { email: email.toLowerCase(), name, passwordHash: await bcrypt.hash(password, 10) },
  });
  await writeAudit({ userId: user.id, action: 'ACCOUNT_CREATED', detail: { email: user.email } });

  const token = signToken({ id: user.id, email: user.email });
  return ok({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
}
