import bcrypt from 'bcryptjs';
import { prisma } from './_lib/prisma.js';
import { signToken, parseBody, requireMethod, ok, unauthorized, tooMany, type FnEvent } from './_lib/http.js';
import { LOGIN_LOCK_MS, LOGIN_MAX_FAILURES, LOCKED_OUT_MESSAGE, PASSWORD_MAX, normalizeEmail } from './_lib/auth.js';

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;

  const { email, password } = parseBody<{ email?: string; password?: string }>(event);
  const normalized = normalizeEmail(email);
  if (!normalized || typeof password !== 'string' || password.length === 0 || password.length > PASSWORD_MAX) {
    return unauthorized('Invalid credentials');
  }

  const user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    return unauthorized('Invalid credentials');
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await bcrypt.compare(password, user.passwordHash);
    return tooMany(LOCKED_OUT_MESSAGE, 'LOCKED_OUT');
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    const fails = user.failedLoginCount + 1;
    const lock = fails >= LOGIN_MAX_FAILURES;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: lock ? 0 : fails,
        lockedUntil: lock ? new Date(Date.now() + LOGIN_LOCK_MS) : null,
      },
    });
    return unauthorized('Invalid credentials');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null },
  });

  const token = signToken({ id: user.id, email: user.email, sv: user.sessionVersion });
  return ok({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
}
