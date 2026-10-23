import bcrypt from 'bcryptjs';
import { prisma } from './_lib/prisma.js';
import { signToken, parseBody, requireMethod, ok, unauthorized, json, type FnEvent } from './_lib/http.js';
import { normalizeEmail, validateEmail, validatePassword } from './_lib/validate.js';

export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;

  const { email, password } = parseBody<{ email?: string; password?: string }>(event);
  const fields: Record<string, string> = {};
  const emailErr = validateEmail(email);
  const pwErr = validatePassword(password, false);
  if (emailErr) fields.email = emailErr;
  if (pwErr) fields.password = pwErr;
  if (Object.keys(fields).length) return json(400, { error: Object.values(fields)[0], fields });

  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email as string) } });
  if (!user || !(await bcrypt.compare(password as string, user.passwordHash))) {
    return unauthorized('Invalid credentials');
  }

  const token = signToken({ id: user.id, email: user.email });
  return ok({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
}
