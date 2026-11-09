import bcrypt from 'bcryptjs';
import { prisma } from './_lib/prisma.js';
import { writeAudit } from './_lib/audit.js';
import { signToken, parseBody, requireMethod, ok, bad, json, type FnEvent } from './_lib/http.js';
import { normalizeEmail, passwordError } from './_lib/auth.js';

export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;

  const { email, password, name } = parseBody<{ email?: string; password?: string; name?: string }>(event);
  if (!email || !password || !name) return bad('email, password and name are required');
  const problem = passwordError(password);
  if (problem) return bad(problem);
  const normalized = normalizeEmail(email);
  if (!normalized) return bad('Enter a valid email address.');

  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) return json(409, { error: 'An account with that email already exists' });

  const user = await prisma.user.create({
    data: { email: normalized, name, passwordHash: await bcrypt.hash(password, 10) },
  });
  await writeAudit({ userId: user.id, action: 'ACCOUNT_CREATED', detail: { email: user.email } });

  const token = signToken({ id: user.id, email: user.email, sv: user.sessionVersion });
  return ok({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
}
