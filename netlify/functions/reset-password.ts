import { prisma } from './_lib/prisma.js';
import { writeAudit } from './_lib/audit.js';
import { parseBody, requireMethod, ok, bad, type FnEvent } from './_lib/http.js';
import { hashResetToken, passwordError, setPasswordAndInvalidateSessions } from './_lib/auth.js';

const INVALID = 'This reset link is invalid or has expired.';

/** Set a new password from a single-use token and invalidate existing sessions. */
export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;

  const { token, password } = parseBody<{ token?: string; password?: string }>(event);
  if (!token || typeof token !== 'string') return bad(INVALID);
  const problem = passwordError(password);
  if (problem) return bad(problem);

  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: hashResetToken(token) } });
  if (!row?.userId || row.usedAt || !row.expiresAt || row.expiresAt.getTime() <= Date.now()) {
    return bad(INVALID);
  }

  const claim = await prisma.passwordReset.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claim.count !== 1) return bad(INVALID);

  try {
    await setPasswordAndInvalidateSessions(row.userId, password as string);
  } catch (err) {
    console.error('[reset-password] update failed');
    return bad(INVALID);
  }
  await writeAudit({ userId: row.userId, action: 'PASSWORD_RESET', detail: { via: 'email' } });
  return ok({ reset: true });
}
