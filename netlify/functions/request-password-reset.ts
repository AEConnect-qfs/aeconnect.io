import { prisma } from './_lib/prisma.js';
import { parseBody, requireMethod, ok, bad, tooMany, unavailable, type FnEvent } from './_lib/http.js';
import {
  RESET_GENERIC_MESSAGE,
  RESET_MAX_PER_WINDOW,
  RESET_RATE_LIMIT_MESSAGE,
  RESET_TTL_MS,
  RESET_WINDOW_MS,
  emailKey,
  hashResetToken,
  newResetToken,
  normalizeEmail,
} from './_lib/auth.js';
import { mailConfigError, sendMail } from './_lib/mail.js';
import { siteUrl } from './_lib/site.js';

/**
 * Always answers with the same body for a well-formed email, whether or not an
 * account exists. Over-limit emails get the same 429 either way. The raw token
 * is only placed in the email (or the dev log); it is stored as a sha256 hash.
 */
export async function handler(event: FnEvent) {
  const m = requireMethod(event, 'POST');
  if (m) return m;

  const configError = mailConfigError();
  if (configError) return unavailable(configError, 'EMAIL_NOT_CONFIGURED');

  const { email } = parseBody<{ email?: string }>(event);
  const normalized = normalizeEmail(email);
  if (!normalized) return bad('Enter a valid email address.');

  const key = emailKey(normalized);
  const since = new Date(Date.now() - RESET_WINDOW_MS);
  const recent = await prisma.passwordReset.count({
    where: { emailKey: key, createdAt: { gte: since } },
  });
  if (recent >= RESET_MAX_PER_WINDOW) {
    return tooMany(RESET_RATE_LIMIT_MESSAGE, 'RATE_LIMITED');
  }

  const user = await prisma.user.findUnique({
    where: { email: normalized },
    select: { id: true, email: true },
  });

  if (!user) {
    await prisma.passwordReset.create({ data: { emailKey: key } });
    return ok({ ok: true, message: RESET_GENERIC_MESSAGE });
  }

  await prisma.passwordReset.updateMany({
    where: { userId: user.id, usedAt: null, tokenHash: { not: null } },
    data: { usedAt: new Date() },
  });

  const token = newResetToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await prisma.passwordReset.create({
    data: {
      userId: user.id,
      emailKey: key,
      tokenHash: hashResetToken(token),
      expiresAt,
    },
  });

  const link = `${siteUrl(event)}/app/reset.html?token=${encodeURIComponent(token)}`;
  try {
    await sendMail({
      to: user.email,
      subject: 'Reset your AE Connect password',
      text: [
        'A password reset was requested for your AE Connect account.',
        '',
        'This link expires in 30 minutes and can be used once:',
        link,
        '',
        'If you did not ask for this, ignore this email. Your password will not change.',
      ].join('\n'),
    });
  } catch (err) {
    console.error('[password-reset] delivery failed');
  }

  return ok({ ok: true, message: RESET_GENERIC_MESSAGE });
}
