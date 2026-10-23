import bcrypt from 'bcryptjs';
import { prisma } from './_lib/prisma.js';
import { writeAudit } from './_lib/audit.js';
import { signToken, parseBody, requireMethod, ok, json, type FnEvent } from './_lib/http.js';
import { normalizeEmail, validateEmail, validateName, validatePassword } from './_lib/validate.js';

export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;

  const { email, password, name } = parseBody<{ email?: string; password?: string; name?: string }>(event);
  const fields: Record<string, string> = {};
  const nameErr = validateName(name);
  const emailErr = validateEmail(email);
  const pwErr = validatePassword(password, true);
  if (nameErr) fields.name = nameErr;
  if (emailErr) fields.email = emailErr;
  if (pwErr) fields.password = pwErr;
  if (Object.keys(fields).length) return json(400, { error: Object.values(fields)[0], fields });

  const normalized = normalizeEmail(email as string);
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) return json(409, { error: 'An account with that email already exists' });

  const user = await prisma.user.create({
    data: { email: normalized, name: (name as string).trim(), passwordHash: await bcrypt.hash(password as string, 10) },
  });
  await writeAudit({ userId: user.id, action: 'ACCOUNT_CREATED', detail: { email: user.email } });

  const token = signToken({ id: user.id, email: user.email });
  return ok({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
}
