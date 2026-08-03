import { createHash } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma.js';

/**
 * Append-only, hash-chained audit log (spec §7). Each entry's
 * hash = sha256(prevHash + canonicalPayload), chained per user.
 */
type Db = PrismaClient | Prisma.TransactionClient;

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(',')}}`;
}

function computeHash(prevHash: string | null, payload: object): string {
  return createHash('sha256').update((prevHash ?? '') + canonicalize(payload)).digest('hex');
}

export async function writeAudit(
  input: { userId: string; caseId?: string | null; action: string; detail: unknown },
  tx: Db = prisma,
): Promise<string> {
  const detailStr = typeof input.detail === 'string' ? input.detail : JSON.stringify(input.detail);
  const last = await tx.auditLog.findFirst({
    where: { userId: input.userId },
    orderBy: { createdAt: 'desc' },
    select: { hash: true },
  });
  const prevHash = last?.hash ?? null;
  const createdAt = new Date();
  const hash = computeHash(prevHash, {
    userId: input.userId,
    caseId: input.caseId ?? null,
    action: input.action,
    detail: detailStr,
    createdAt: createdAt.toISOString(),
  });
  await tx.auditLog.create({
    data: {
      userId: input.userId,
      caseId: input.caseId ?? null,
      action: input.action,
      detail: detailStr,
      prevHash,
      hash,
      createdAt,
    },
  });
  return hash;
}

export async function verifyAuditChain(userId: string): Promise<{ ok: boolean; brokenAt: string | null }> {
  const entries = await prisma.auditLog.findMany({
    where: { userId, hash: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
  let prevHash: string | null = null;
  for (const e of entries) {
    const expected = computeHash(prevHash, {
      userId: e.userId,
      caseId: e.caseId,
      action: e.action,
      detail: e.detail,
      createdAt: e.createdAt.toISOString(),
    });
    if (e.prevHash !== prevHash || e.hash !== expected) return { ok: false, brokenAt: e.id };
    prevHash = e.hash;
  }
  return { ok: true, brokenAt: null };
}
