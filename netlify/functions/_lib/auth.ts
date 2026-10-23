import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { prisma } from './prisma.js';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;
export const RESET_WINDOW_MS = 15 * 60 * 1000;
export const RESET_MAX_PER_WINDOW = 3;
export const RESET_GENERIC_MESSAGE =
  'If an account exists for that email, we sent reset instructions.';
export const RESET_RATE_LIMIT_MESSAGE = 'Too many reset requests. Try again later.';
export const LOCKED_OUT_MESSAGE = 'Too many attempts. Try again later.';

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

export function passwordError(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters`;
  }
  if (password.length > PASSWORD_MAX) return 'Password is too long';
  return null;
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newResetToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Stable bucket for reset rate limiting. Not reversible from the table alone. */
export function emailKey(email: string): string {
  return createHash('sha256').update(email).digest('hex');
}

/** Set a new password, clear login lockout, and invalidate every existing JWT. */
export async function setPasswordAndInvalidateSessions(userId: string, password: string): Promise<void> {
  const problem = passwordError(password);
  if (problem) throw new Error(problem);
  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        sessionVersion: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.passwordReset.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    }),
  ]);
}
