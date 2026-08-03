import bcrypt from 'bcryptjs';
import { prisma } from './_lib/prisma.js';
import { signToken, parseBody, requireMethod, ok, unauthorized, type FnEvent } from './_lib/http.js';

export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;

  const { email, password } = parseBody<{ email?: string; password?: string }>(event);
  if (!email || !password) return unauthorized('Invalid credentials');

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return unauthorized('Invalid credentials');
  }

  const token = signToken({ id: user.id, email: user.email });
  return ok({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
}
